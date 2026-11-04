/**
 * Only the money events. Everything else (screens, behaviour, diagnostics)
 * is deliberately not offered — Viewthrough is not a product-analytics tool.
 * Trials, purchases, cancellations and refunds are taken from the store via
 * the RevenueCat webhook; `trial_started` and `purchase` here mean "what the
 * app reported", shown as such.
 */
export const COUNT_EVENTS = [
  "install",
  "app_open",
  "onboarding_started",
  "onboarding_completed",
  "paywall_shown",
  "checkout_started",
  "trial_started",
  "purchase",
] as const;
export type CountEvent = (typeof COUNT_EVENTS)[number];

export type ControlEvent = "identify" | "set_attribution" | "opt_out" | "opt_in";
export type EventName = CountEvent | ControlEvent;

export type Platform = "ios" | "android" | "web" | "unknown";

export type Props = Record<string, string | number | boolean | null | undefined>;

/** What goes over the wire, one per event. */
export type QueuedEvent = {
  event_id: string;
  event: EventName;
  ts: string;
  user_id?: string;
  props?: Record<string, string | number | boolean>;
};

/**
 * Where the SDK keeps the device id and the offline queue. Pass
 * AsyncStorage (React Native), or nothing on the web (localStorage is picked
 * up automatically). Without any storage the SDK still works, but a cold
 * start forgets the device id — every start would count as an install.
 */
export interface Storage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

export type Attribution = {
  /** "How did you hear about us?" — the self-reported channel. */
  acquisition_source?: string;
  /** Campaign of a Viewthrough tracking link (Play Install Referrer / deep link). */
  install_utm_campaign?: string;
  install_utm_source?: string;
  install_utm_medium?: string;
  install_referrer?: string;
  [key: string]: string | number | boolean | null | undefined;
};

export type ViewthroughOptions = {
  /** The app's write key from Sources → SDK in Viewthrough (`vts_…`). */
  key: string;
  /** Defaults to https://viewthrough.app/api/v1/events. */
  endpoint?: string;
  /** ios | android | web. Detected on the web; pass it in React Native. */
  platform?: Platform;
  /** Your app's version, e.g. from expo-constants or react-native-device-info. */
  appVersion?: string;
  osVersion?: string;
  /** e.g. "de-DE". */
  locale?: string;
  storage?: Storage;
  /** Custom fetch (tests, polyfills). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Send after this many queued events (default 20, max 100). */
  flushAt?: number;
  /** Send at least this often while something is queued (default 30 s). */
  flushIntervalMs?: number;
  /** Keep at most this many events offline (default 5000); the oldest go first. */
  maxQueue?: number;
  /** Log what the SDK does to console.debug. */
  debug?: boolean;
  /** Send `app_open` on init (default true). */
  trackAppOpen?: boolean;
  /** For tests. */
  now?: () => Date;
};
