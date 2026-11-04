import type { QueuedEvent } from "./types.js";

/**
 * The offline queue, as pure functions over an array. The client owns the
 * array and persists it; these decide what to send and what to keep.
 */

export const SERVER_MAX_BATCH = 100;

/** Backoff after a failed send: 1 s, 2 s, 4 s … capped at 5 min. */
export function backoffMs(attempt: number): number {
  return Math.min(300_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

/** Append, dropping the oldest beyond `max` — the only place events are lost on purpose. */
export function push(queue: QueuedEvent[], event: QueuedEvent, max: number): { queue: QueuedEvent[]; dropped: number } {
  const next = [...queue, event];
  const dropped = Math.max(0, next.length - max);
  return { queue: dropped ? next.slice(dropped) : next, dropped };
}

/** The next batch to send: the oldest events, at most what the server takes. */
export function nextBatch(queue: QueuedEvent[], flushAt: number): QueuedEvent[] {
  return queue.slice(0, Math.min(SERVER_MAX_BATCH, Math.max(1, flushAt)));
}

/** Remove the events of a sent batch (by id — the queue may have grown meanwhile). */
export function remove(queue: QueuedEvent[], sent: readonly QueuedEvent[]): QueuedEvent[] {
  const ids = new Set(sent.map((e) => e.event_id));
  return queue.filter((e) => !ids.has(e.event_id));
}

/**
 * What to do with an HTTP status:
 *   sent      202 — remove the batch
 *   drop      4xx that a retry won't fix (400, 413) — remove and warn
 *   stop      401 — key wrong: keep the queue, stop trying until next init
 *   retry     429, 5xx, network — keep, back off
 */
export type Outcome = "sent" | "drop" | "stop" | "retry";

export function outcomeFor(status: number | null): Outcome {
  if (status === null) return "retry";
  if (status === 202 || status === 200) return "sent";
  if (status === 401 || status === 403) return "stop";
  if (status === 429 || status >= 500) return "retry";
  if (status >= 400) return "drop";
  return "retry";
}

export function parseQueue(raw: string | null): QueuedEvent[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((e) => e && typeof e.event_id === "string" && typeof e.event === "string") : [];
  } catch {
    return [];
  }
}
