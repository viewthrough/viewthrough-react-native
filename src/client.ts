import { backoffMs, nextBatch, outcomeFor, parseQueue, push, remove } from "./queue.js";
import { detectStorage, safeStorage } from "./storage.js";
import type {
  Attribution,
  CountEvent,
  Platform,
  Props,
  QueuedEvent,
  Storage,
  ViewthroughOptions,
} from "./types.js";
import { COUNT_EVENTS } from "./types.js";
import { uuid } from "./uuid.js";

export const SDK_NAME = "@viewthrough/sdk";
export const SDK_VERSION = "0.1.0";
export const DEFAULT_ENDPOINT = "https://viewthrough.app/api/v1/events";

type Persisted = {
  device_id: string;
  user_id?: string;
  opted_out?: boolean;
  installed_at?: string;
};

/**
 * The client. One instance per app; create it once at startup.
 *
 * Identity is the heart of it, not the events: `device_id` is made on the
 * first start and kept on the device (survives logout, not reinstall) —
 * that is the install. After login, `identify(userId)` adds the user id to
 * everything from then on. Give RevenueCat the SAME id
 * (`Purchases.logIn(userId)`), or Viewthrough cannot tie purchases to
 * installs.
 */
export class Viewthrough {
  private readonly opts: Required<Pick<ViewthroughOptions, "endpoint" | "flushAt" | "flushIntervalMs" | "maxQueue" | "trackAppOpen">> & ViewthroughOptions;
  private readonly storage: Storage;
  private readonly fetchFn: typeof fetch;
  private readonly keyNs: string;
  private state: Persisted | null = null;
  private queue: QueuedEvent[] = [];
  private attempt = 0;
  private stopped = false;
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextAllowedAt = 0;
  /** Resolves once device id and queue are loaded. Awaiting it is optional. */
  readonly ready: Promise<void>;

  constructor(options: ViewthroughOptions) {
    if (!options.key || !/^vts_[A-Za-z0-9_-]{43}$/.test(options.key)) {
      throw new Error("Viewthrough: `key` must be the app's SDK key (vts_…) from Sources → SDK");
    }
    this.opts = {
      endpoint: DEFAULT_ENDPOINT,
      flushAt: 20,
      flushIntervalMs: 30_000,
      maxQueue: 5_000,
      trackAppOpen: true,
      ...options,
    };
    this.storage = safeStorage(options.storage ?? detectStorage(), (m) => this.warn(m));
    const f = options.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) throw new Error("Viewthrough: no fetch available — pass `fetch` in the options");
    this.fetchFn = f;
    this.keyNs = `vt:${options.key.slice(4, 12)}`;
    this.ready = this.load();
  }

  // ---------------------------------------------------------------- events

  /** Record one of the money events. Unknown names are rejected at compile time and at runtime. */
  track(event: CountEvent, props?: Props): void {
    if (!(COUNT_EVENTS as readonly string[]).includes(event)) {
      this.warn(`track: "${event}" is not a Viewthrough event; use one of ${COUNT_EVENTS.join(", ")}`);
      return;
    }
    this.enqueue(event, props);
  }

  onboardingStarted(props?: Props): void {
    this.track("onboarding_started", props);
  }
  onboardingCompleted(props?: Props): void {
    this.track("onboarding_completed", props);
  }
  /** e.g. { surface: "onboarding" | "settings" | "feature_gate" } */
  paywallShown(props?: Props & { surface?: string }): void {
    this.track("paywall_shown", props);
  }
  /** e.g. { product_id, plan } */
  checkoutStarted(props?: Props & { product_id?: string; plan?: string }): void {
    this.track("checkout_started", props);
  }
  /** What the app saw. The store's view comes from RevenueCat. */
  trialStarted(props?: Props & { product_id?: string }): void {
    this.track("trial_started", props);
  }
  purchase(props?: Props & { product_id?: string; plan?: string }): void {
    this.track("purchase", props);
  }
  /** Call on foreground if you want app opens beyond cold starts. */
  appOpened(): void {
    this.track("app_open");
  }

  // -------------------------------------------------------------- identity

  /** After login. Use the same id for RevenueCat (`Purchases.logIn`). */
  identify(userId: string): void {
    const id = String(userId ?? "").trim();
    if (!id || /\s/.test(id) || id.length > 128) {
      this.warn("identify: user id must be a non-empty string without whitespace (max 128)");
      return;
    }
    void this.ready.then(() => {
      if (!this.state) return;
      if (this.state.user_id === id) return;
      this.state.user_id = id;
      void this.persistState();
      this.enqueue("identify", undefined, id);
    });
  }

  /**
   * Where this install came from: the onboarding question
   * (`acquisition_source`) and/or the tracking-link campaign
   * (`install_utm_campaign` from the Play Install Referrer or a deep link).
   * Stored on the device, not counted as an event.
   */
  setAttribution(attribution: Attribution): void {
    const clean: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(attribution)) {
      if (v === null || v === undefined || v === "") continue;
      if (typeof v === "string") clean[k] = v.slice(0, 256);
      else if (typeof v === "number" || typeof v === "boolean") clean[k] = v;
    }
    if (Object.keys(clean).length === 0) return;
    this.enqueue("set_attribution", clean);
  }

  /** On logout: forget the user id. The device id stays — it is still the same install. */
  reset(): void {
    void this.ready.then(() => {
      if (!this.state) return;
      delete this.state.user_id;
      void this.persistState();
    });
  }

  /** Stop collecting and tell the server to drop this device from every count. */
  optOut(): void {
    void this.ready.then(async () => {
      if (!this.state || this.state.opted_out) return;
      this.enqueue("opt_out");
      this.state.opted_out = true;
      await this.persistState();
      await this.flush();
    });
  }

  optIn(): void {
    void this.ready.then(() => {
      if (!this.state || !this.state.opted_out) return;
      this.state.opted_out = false;
      void this.persistState();
      this.enqueue("opt_in");
    });
  }

  async getDeviceId(): Promise<string> {
    await this.ready;
    return this.state!.device_id;
  }

  async isOptedOut(): Promise<boolean> {
    await this.ready;
    return !!this.state?.opted_out;
  }

  // --------------------------------------------------------------- sending

  /** Send everything queued now. Safe to call often; concurrent calls share one send. */
  async flush(): Promise<void> {
    await this.ready;
    if (this.flushing) return this.flushing;
    this.flushing = this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** Stop timers (tests, hot reload). Queued events stay on disk. */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // -------------------------------------------------------------- internal

  private async load(): Promise<void> {
    const [rawState, rawQueue] = await Promise.all([
      this.storage.getItem(`${this.keyNs}:state`),
      this.storage.getItem(`${this.keyNs}:queue`),
    ]);
    let state: Persisted | null = null;
    try {
      const v = rawState ? (JSON.parse(rawState) as Persisted) : null;
      if (v && typeof v.device_id === "string" && v.device_id.length >= 8) state = v;
    } catch {
      state = null;
    }
    this.queue = parseQueue(rawQueue);
    const now = (this.opts.now ?? (() => new Date()))();
    if (!state) {
      // First start on this device: that is the install.
      state = { device_id: uuid(), installed_at: now.toISOString() };
      this.state = state;
      await this.persistState();
      this.enqueueNow("install", undefined, undefined, now);
    } else {
      this.state = state;
    }
    if (this.opts.trackAppOpen && !state.opted_out) this.enqueueNow("app_open", undefined, undefined, now);
    this.schedule(0);
  }

  private enqueue(event: QueuedEvent["event"], props?: Props, userId?: string): void {
    void this.ready.then(() => {
      if (this.state?.opted_out && event !== "opt_in" && event !== "opt_out") return;
      this.enqueueNow(event, props, userId, (this.opts.now ?? (() => new Date()))());
    });
  }

  private enqueueNow(event: QueuedEvent["event"], props: Props | undefined, userId: string | undefined, at: Date): void {
    const q: QueuedEvent = { event_id: uuid(), event, ts: at.toISOString() };
    const uid = userId ?? this.state?.user_id;
    if (uid) q.user_id = uid;
    const clean = cleanProps(props);
    if (clean) q.props = clean;
    const { queue, dropped } = push(this.queue, q, this.opts.maxQueue);
    this.queue = queue;
    if (dropped) this.warn(`queue full (${this.opts.maxQueue}), dropped ${dropped} oldest event(s)`);
    void this.persistQueue();
    this.debug(`queued ${event} (${this.queue.length} waiting)`);
    if (this.queue.length >= this.opts.flushAt) this.schedule(0);
    else this.schedule(this.opts.flushIntervalMs);
  }

  private schedule(inMs: number): void {
    if (this.stopped || this.queue.length === 0) return;
    const delay = Math.max(inMs, this.nextAllowedAt - Date.now());
    if (this.timer) {
      // An earlier timer wins; a shorter one replaces it.
      if (delay >= (this.timerDueAt ?? Infinity) - Date.now()) return;
      clearTimeout(this.timer);
    }
    this.timerDueAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerDueAt = null;
      void this.flush();
    }, delay);
    // Never keep a Node process alive just for us.
    (this.timer as { unref?: () => void }).unref?.();
  }
  private timerDueAt: number | null = null;

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.stopped) {
      if (Date.now() < this.nextAllowedAt) {
        this.schedule(this.nextAllowedAt - Date.now());
        return;
      }
      const batch = nextBatch(this.queue, Math.max(this.opts.flushAt, SERVER_MAX_BATCH_HINT));
      const status = await this.send(batch);
      const outcome = outcomeFor(status);
      if (outcome === "sent") {
        this.queue = remove(this.queue, batch);
        this.attempt = 0;
        await this.persistQueue();
        this.debug(`sent ${batch.length} event(s)`);
        continue;
      }
      if (outcome === "drop") {
        this.queue = remove(this.queue, batch);
        await this.persistQueue();
        this.warn(`server rejected ${batch.length} event(s) with HTTP ${status}; dropped`);
        continue;
      }
      if (outcome === "stop") {
        this.stopped = true;
        this.warn(`HTTP ${status}: the SDK key is unknown or revoked — events stay queued until the next start`);
        return;
      }
      this.attempt += 1;
      const wait = backoffMs(this.attempt);
      this.nextAllowedAt = Date.now() + wait;
      this.debug(`send failed (${status ?? "network"}), retry in ${Math.round(wait / 1000)} s`);
      this.schedule(wait);
      return;
    }
  }

  private async send(batch: QueuedEvent[]): Promise<number | null> {
    const body = JSON.stringify({
      device_id: this.state!.device_id,
      user_id: this.state!.user_id,
      platform: this.opts.platform ?? detectPlatform(),
      app_version: this.opts.appVersion,
      os_version: this.opts.osVersion,
      locale: this.opts.locale ?? detectLocale(),
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      sent_at: (this.opts.now ?? (() => new Date()))().toISOString(),
      events: batch,
    });
    try {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const t = controller ? setTimeout(() => controller.abort(), 15_000) : null;
      const res = await this.fetchFn(this.opts.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.key}` },
        body,
        signal: controller?.signal,
        keepalive: true,
      });
      if (t) clearTimeout(t);
      return res.status;
    } catch {
      return null;
    }
  }

  private async persistState(): Promise<void> {
    if (this.state) await this.storage.setItem(`${this.keyNs}:state`, JSON.stringify(this.state));
  }

  private async persistQueue(): Promise<void> {
    if (this.queue.length === 0) await this.storage.removeItem(`${this.keyNs}:queue`);
    else await this.storage.setItem(`${this.keyNs}:queue`, JSON.stringify(this.queue));
  }

  private warn(msg: string): void {
    if (typeof console !== "undefined") console.warn(`[viewthrough] ${msg}`);
  }

  private debug(msg: string): void {
    if (this.opts.debug && typeof console !== "undefined") console.debug(`[viewthrough] ${msg}`);
  }
}

/** flushAt decides when to send; the batch itself takes up to the server maximum. */
const SERVER_MAX_BATCH_HINT = 100;

function cleanProps(props: Props | undefined): Record<string, string | number | boolean> | undefined {
  if (!props) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") out[k] = v.slice(0, 256);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function detectPlatform(): Platform {
  const nav = (globalThis as { navigator?: { product?: string; userAgent?: string } }).navigator;
  if (nav?.product === "ReactNative") return "unknown"; // pass `platform` from react-native's Platform.OS
  if (typeof (globalThis as { document?: unknown }).document !== "undefined") return "web";
  return "unknown";
}

function detectLocale(): string | undefined {
  const nav = (globalThis as { navigator?: { language?: string } }).navigator;
  return nav?.language;
}

/** `createViewthrough(options)` — the same as `new Viewthrough(options)`. */
export function createViewthrough(options: ViewthroughOptions): Viewthrough {
  return new Viewthrough(options);
}
