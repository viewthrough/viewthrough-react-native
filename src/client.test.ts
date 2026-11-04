import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Viewthrough } from "./client.js";
import { memoryStorage } from "./storage.js";
import type { Storage } from "./types.js";

const KEY = `vts_${"a".repeat(43)}`;

type Sent = { body: Record<string, unknown>; headers: Record<string, string> };

function fakeFetch(statuses: number[] = [202]) {
  const calls: Sent[] = [];
  const fn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
    calls.push({
      body: JSON.parse(String(init?.body)),
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
    });
    return new Response(null, { status });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

// Fake timers: setTimeout(0) would never fire. The client chains on
// `ready.then(...)`, so a few microtask turns are enough.
const flushMicrotasks = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("Viewthrough client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("first start: makes a device id, queues install and app_open, sends with the key", async () => {
    const { fn, calls } = fakeFetch();
    const vt = new Viewthrough({ key: KEY, fetch: fn, storage: memoryStorage(), platform: "ios", appVersion: "1.0.0" });
    await vt.ready;
    await vt.flush();
    expect(calls).toHaveLength(1);
    const { body, headers } = calls[0]!;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(body.platform).toBe("ios");
    expect(body.app_version).toBe("1.0.0");
    expect((body.events as Array<{ event: string }>).map((e) => e.event)).toEqual(["install", "app_open"]);
    expect(await vt.getDeviceId()).toMatch(/^[0-9a-f-]{36}$/);
    vt.close();
  });

  it("second start on the same device: no install, same device id", async () => {
    const storage = memoryStorage();
    const a = new Viewthrough({ key: KEY, fetch: fakeFetch().fn, storage });
    await a.ready;
    await a.flush();
    const id = await a.getDeviceId();
    a.close();

    const { fn, calls } = fakeFetch();
    const b = new Viewthrough({ key: KEY, fetch: fn, storage });
    await b.ready;
    await b.flush();
    expect(await b.getDeviceId()).toBe(id);
    expect((calls[0]!.body.events as Array<{ event: string }>).map((e) => e.event)).toEqual(["app_open"]);
    b.close();
  });

  it("identify adds the user id to everything after it; reset forgets it", async () => {
    const { fn, calls } = fakeFetch();
    const vt = new Viewthrough({ key: KEY, fetch: fn, storage: memoryStorage(), trackAppOpen: false });
    await vt.ready;
    vt.identify("user_42");
    await flushMicrotasks();
    vt.paywallShown({ surface: "onboarding" });
    await flushMicrotasks();
    await vt.flush();
    const events = calls[0]!.body.events as Array<{ event: string; user_id?: string; props?: Record<string, unknown> }>;
    expect(events.map((e) => e.event)).toEqual(["install", "identify", "paywall_shown"]);
    expect(events[1]!.user_id).toBe("user_42");
    expect(events[2]!.user_id).toBe("user_42");
    expect(events[2]!.props).toEqual({ surface: "onboarding" });
    expect(calls[0]!.body.user_id).toBe("user_42");

    vt.reset();
    await flushMicrotasks();
    vt.checkoutStarted();
    await flushMicrotasks();
    await vt.flush();
    const later = calls[1]!.body.events as Array<{ event: string; user_id?: string }>;
    expect(later[0]!.event).toBe("checkout_started");
    expect(later[0]!.user_id).toBeUndefined();
    vt.close();
  });

  it("keeps the queue on 5xx and retries after backoff; drops on 400", async () => {
    const { fn, calls } = fakeFetch([503, 202]);
    const vt = new Viewthrough({ key: KEY, fetch: fn, storage: memoryStorage(), trackAppOpen: false });
    await vt.ready;
    await vt.flush();
    expect(calls).toHaveLength(1);
    // Backoff 1 s, then the timer resends the same events.
    await vi.advanceTimersByTimeAsync(1_100);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.events).toEqual(calls[0]!.body.events);

    const bad = fakeFetch([400]);
    const vt2 = new Viewthrough({ key: KEY, fetch: bad.fn, storage: memoryStorage(), trackAppOpen: false });
    await vt2.ready;
    await vt2.flush();
    await vt2.flush();
    expect(bad.calls).toHaveLength(1);
    vt.close();
    vt2.close();
  });

  it("stops on 401 but keeps the events", async () => {
    const storage = memoryStorage();
    const { fn, calls } = fakeFetch([401]);
    const vt = new Viewthrough({ key: KEY, fetch: fn, storage, trackAppOpen: false });
    await vt.ready;
    await vt.flush();
    await vt.flush();
    expect(calls).toHaveLength(1);
    expect(JSON.parse((await storage.getItem(`vt:${KEY.slice(4, 12)}:queue`)) ?? "[]")).toHaveLength(1);
    vt.close();
  });

  it("sends when flushAt is reached without waiting for the timer", async () => {
    const { fn, calls } = fakeFetch();
    const vt = new Viewthrough({ key: KEY, fetch: fn, storage: memoryStorage(), flushAt: 3, trackAppOpen: false });
    await vt.ready; // install queued (1)
    vt.onboardingStarted(); // 2
    vt.onboardingCompleted(); // 3 → flush
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.events).toHaveLength(3);
    vt.close();
  });

  it("opt-out: sends opt_out, then nothing; opt-in resumes", async () => {
    const { fn, calls } = fakeFetch();
    const vt = new Viewthrough({ key: KEY, fetch: fn, storage: memoryStorage(), trackAppOpen: false });
    await vt.ready;
    vt.optOut();
    await flushMicrotasks();
    await vt.flush();
    vt.paywallShown();
    await flushMicrotasks();
    await vt.flush();
    const all = calls.flatMap((c) => (c.body.events as Array<{ event: string }>).map((e) => e.event));
    expect(all).toEqual(["install", "opt_out"]);
    expect(await vt.isOptedOut()).toBe(true);
    vt.optIn();
    await flushMicrotasks();
    vt.paywallShown();
    await flushMicrotasks();
    await vt.flush();
    const after = calls.at(-1)!.body.events as Array<{ event: string }>;
    expect(after.map((e) => e.event)).toEqual(["opt_in", "paywall_shown"]);
    vt.close();
  });

  it("setAttribution queues a control event with clean props", async () => {
    const { fn, calls } = fakeFetch();
    const vt = new Viewthrough({ key: KEY, fetch: fn, storage: memoryStorage(), trackAppOpen: false });
    await vt.ready;
    vt.setAttribution({ acquisition_source: "tiktok", install_utm_campaign: "training", empty: "", nothing: null });
    await flushMicrotasks();
    await vt.flush();
    const ev = (calls[0]!.body.events as Array<{ event: string; props?: Record<string, unknown> }>).find((e) => e.event === "set_attribution");
    expect(ev?.props).toEqual({ acquisition_source: "tiktok", install_utm_campaign: "training" });
    vt.close();
  });

  it("rejects a key that is not an SDK key", () => {
    expect(() => new Viewthrough({ key: "vt_nope", fetch: fakeFetch().fn })).toThrow(/vts_/);
  });

  it("a storage that throws never breaks the app", async () => {
    const broken: Storage = {
      getItem: () => {
        throw new Error("disk");
      },
      setItem: () => {
        throw new Error("disk");
      },
      removeItem: () => {
        throw new Error("disk");
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fn, calls } = fakeFetch();
    const vt = new Viewthrough({ key: KEY, fetch: fn, storage: broken });
    await vt.ready;
    await vt.flush();
    expect(calls).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    vt.close();
  });
});
