# @viewthrough/sdk

Installs, onboarding, paywall and checkout events from your app into
[Viewthrough](https://viewthrough.app) — so you can see which creators and
which videos bring installs, trials and revenue. Batched, offline-safe,
no device fingerprinting, no IP stored.

Works in **React Native**, **Expo**, **web** and **Node**. Any other platform
(Swift, Kotlin, Flutter, Unity) uses the same HTTP API — see the bottom of
this page; it is one `POST`.

## The one rule: identity

Viewthrough ties installs to purchases by **one id that is the same
everywhere**:

- `device_id` — created by the SDK on the first start and kept on the
  device. Survives logout, not reinstall. **That is the install.**
- `user_id` — set by your app after login with `identify(userId)`. From then
  on every event carries both ids and the server links the device's earlier
  events to the user.

**Give RevenueCat the same `user_id`** (`Purchases.logIn(userId)`), or
Viewthrough cannot tie purchases to installs. If your app has no login,
give RevenueCat the device id instead: `Purchases.logIn(await vt.getDeviceId())`.

## Install

```sh
npm install @viewthrough/sdk
# React Native / Expo also need a storage for the device id and the queue:
npm install @react-native-async-storage/async-storage
```

## Setup

```ts
import { createViewthrough } from "@viewthrough/sdk";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

export const vt = createViewthrough({
  key: "vts_…",                // Viewthrough → Sources → SDK
  platform: Platform.OS === "ios" ? "ios" : "android",
  appVersion: "2.4.1",         // e.g. expo-constants / react-native-device-info
  storage: AsyncStorage,
});
```

On the web, leave out `storage` and `platform` — localStorage and the
browser are detected.

That already records the **install** (first start on this device) and an
**app_open** on every cold start. Four more lines cover the funnel:

```ts
vt.onboardingCompleted();
vt.paywallShown({ surface: "onboarding" });
vt.checkoutStarted({ product_id: "pro_yearly" });

// after login — same id you give RevenueCat
vt.identify(user.id);
Purchases.logIn(user.id);

// on logout
vt.reset();
```

### Where the install came from

```ts
// the "How did you hear about us?" answer
vt.setAttribution({ acquisition_source: "tiktok" });

// Android: Play Install Referrer / deep link of a Viewthrough tracking link
vt.setAttribution({ install_utm_campaign: referrer.utm_campaign });
```

Both are stored on the device, not counted as events. `acquisition_source`
becomes the self-reported channel; `install_utm_campaign` ties the install to
a tracking link (`go.yourapp.com/<campaign>`).

### Privacy

- `vt.optOut()` stops collection and removes the device from every count;
  `vt.optIn()` resumes.
- No IP is stored. The country is derived on the server from the request
  and the request is then forgotten.
- No IDFA, no ATT prompt, no fingerprinting. `device_id` is a random UUID.

### Events

Only the money events exist. Anything else is rejected by the server — on
purpose: Viewthrough is not a product-analytics tool, and a limit on
events is not something you want to hit.

| Method | Event | Meaning |
|---|---|---|
| automatic | `install` | first start on this device |
| automatic / `appOpened()` | `app_open` | cold start (and foreground, if you call it) |
| `onboardingStarted()` | `onboarding_started` | |
| `onboardingCompleted()` | `onboarding_completed` | |
| `paywallShown({ surface })` | `paywall_shown` | |
| `checkoutStarted({ product_id, plan })` | `checkout_started` | |
| `trialStarted({ product_id })` | `trial_started` | what the app saw — the store's truth comes from RevenueCat |
| `purchase({ product_id, plan })` | `purchase` | same |

`vt.track(name, props)` takes the same names.

### How sending works

- Events go to a queue on the device and are sent in batches: after 20
  events or every 30 seconds, whichever comes first; `vt.flush()` sends now.
- Offline or server error: the queue stays, the SDK retries with backoff
  (1 s → 5 min). Nothing is dropped except when the queue exceeds 5,000
  events (then the oldest go) or when the server rejects a batch as
  malformed (HTTP 400).
- Every event has a UUID; a batch sent twice counts once.
- A wrong key (HTTP 401) stops sending until the next start; the queue is kept.

Options: `endpoint`, `flushAt`, `flushIntervalMs`, `maxQueue`, `debug`,
`trackAppOpen`, `fetch`, `locale`, `osVersion`.

## HTTP API (any platform)

```
POST https://viewthrough.app/api/v1/events
Authorization: Bearer vts_…          (or header X-Viewthrough-Key: vts_…)
Content-Type: application/json

{
  "device_id": "4a7c…",              // UUID you create on first start and keep
  "user_id": "user_42",              // optional, after login
  "platform": "ios",                 // ios | android | web
  "app_version": "2.4.1",
  "os_version": "18.1",              // optional
  "locale": "de-DE",                 // optional
  "sdk": { "name": "my-swift-client", "version": "1.0" },   // optional
  "sent_at": "2026-11-04T10:00:05Z", // optional; lets the server correct a wrong device clock
  "events": [
    { "event_id": "3f1d…", "event": "install",       "ts": "2026-11-04T09:59:58Z" },
    { "event_id": "8b2e…", "event": "paywall_shown", "ts": "2026-11-04T10:00:03Z",
      "props": { "surface": "onboarding" } }
  ]
}
```

- `event_id`: a UUID per event — the server deduplicates on it.
- `ts`: ISO 8601 or epoch milliseconds; device time is fine.
- `event`: one of `install`, `app_open`, `onboarding_started`,
  `onboarding_completed`, `paywall_shown`, `checkout_started`,
  `trial_started`, `purchase`, plus the control events `identify` (needs
  `user_id` on the event), `set_attribution` (props as above), `opt_out`,
  `opt_in`.
- `props`: flat object of strings, numbers, booleans; max 2 KB.
- Up to 100 events per request.

| Status | Meaning | What to do |
|---|---|---|
| 202 | stored — `{ "accepted": n, "duplicates": m }` | remove the batch from your queue |
| 400 / 413 | malformed, with a message | drop the batch, fix the client |
| 401 | key missing, unknown or revoked | keep the queue, check the key |
| 429 | too many requests | wait `Retry-After` seconds |
| 5xx | server trouble | keep the queue, retry with backoff |

The server takes the country from the connection and does not store the IP.
Store the `device_id` the way you would a settings value (Keychain /
SharedPreferences / UserDefaults); do not reset it on logout.

## License

MIT
