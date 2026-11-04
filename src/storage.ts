import type { Storage } from "./types.js";

/** In-memory storage: survives nothing, but never throws. */
export function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
}

/**
 * Web: localStorage, if it works. Private windows and blocked site data
 * make the accessor throw — then memory it is.
 */
export function detectStorage(): Storage {
  try {
    const ls = (globalThis as { localStorage?: globalThis.Storage }).localStorage;
    if (ls) {
      const probe = "__vt_probe__";
      ls.setItem(probe, "1");
      ls.removeItem(probe);
      return {
        getItem: (k) => ls.getItem(k),
        setItem: (k, v) => ls.setItem(k, v),
        removeItem: (k) => ls.removeItem(k),
      };
    }
  } catch {
    // fall through
  }
  return memoryStorage();
}

/** Every storage call wrapped: a failing disk must never break the app. */
export function safeStorage(inner: Storage, warn: (msg: string) => void): Storage {
  return {
    async getItem(k) {
      try {
        return (await inner.getItem(k)) ?? null;
      } catch (e) {
        warn(`storage.getItem failed: ${String(e)}`);
        return null;
      }
    },
    async setItem(k, v) {
      try {
        await inner.setItem(k, v);
      } catch (e) {
        warn(`storage.setItem failed: ${String(e)}`);
      }
    },
    async removeItem(k) {
      try {
        await inner.removeItem(k);
      } catch (e) {
        warn(`storage.removeItem failed: ${String(e)}`);
      }
    },
  };
}
