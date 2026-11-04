import { describe, expect, it } from "vitest";
import { backoffMs, nextBatch, outcomeFor, parseQueue, push, remove } from "./queue.js";
import type { QueuedEvent } from "./types.js";

const ev = (n: number): QueuedEvent => ({ event_id: `id-${n}`, event: "app_open", ts: "2026-11-04T10:00:00.000Z" });

describe("queue", () => {
  it("drops the oldest beyond the cap, and says so", () => {
    let q: QueuedEvent[] = [];
    for (let i = 0; i < 5; i++) q = push(q, ev(i), 3).queue;
    expect(q.map((e) => e.event_id)).toEqual(["id-2", "id-3", "id-4"]);
    expect(push(q, ev(9), 3).dropped).toBe(1);
  });

  it("sends the oldest first, never more than the server takes", () => {
    const q = Array.from({ length: 250 }, (_, i) => ev(i));
    expect(nextBatch(q, 20).map((e) => e.event_id)[0]).toBe("id-0");
    expect(nextBatch(q, 20)).toHaveLength(20);
    expect(nextBatch(q, 500)).toHaveLength(100);
  });

  it("removes by id, so events queued meanwhile survive", () => {
    const q = [ev(1), ev(2), ev(3)];
    expect(remove(q, [ev(1), ev(2)]).map((e) => e.event_id)).toEqual(["id-3"]);
  });

  it("maps statuses to outcomes", () => {
    expect(outcomeFor(202)).toBe("sent");
    expect(outcomeFor(400)).toBe("drop");
    expect(outcomeFor(413)).toBe("drop");
    expect(outcomeFor(401)).toBe("stop");
    expect(outcomeFor(429)).toBe("retry");
    expect(outcomeFor(503)).toBe("retry");
    expect(outcomeFor(null)).toBe("retry");
  });

  it("backs off exponentially, capped at five minutes", () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(20)).toBe(300_000);
  });

  it("parses a persisted queue defensively", () => {
    expect(parseQueue(null)).toEqual([]);
    expect(parseQueue("not json")).toEqual([]);
    expect(parseQueue(JSON.stringify([ev(1), { broken: true }]))).toHaveLength(1);
  });
});
