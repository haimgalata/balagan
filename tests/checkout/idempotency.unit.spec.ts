import { test, expect } from "@playwright/test";
import { getOrCreateIdempotencyKey, clearIdempotencyKey } from "../../src/checkout/lib/idempotency";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fakeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  } as Storage;
}

test.describe("getOrCreateIdempotencyKey", () => {
  test("creates a valid-looking uuid on first call", () => {
    const key = getOrCreateIdempotencyKey(fakeStorage());
    expect(key).toMatch(UUID_RE);
  });

  test("reuses the SAME key across repeat calls against the same storage (double-click / refresh / retry)", () => {
    const storage = fakeStorage();
    const first = getOrCreateIdempotencyKey(storage);
    const second = getOrCreateIdempotencyKey(storage);
    const third = getOrCreateIdempotencyKey(storage);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  test("different storages (different checkout sessions) get different keys", () => {
    const a = getOrCreateIdempotencyKey(fakeStorage());
    const b = getOrCreateIdempotencyKey(fakeStorage());
    expect(a).not.toBe(b);
  });

  test("a broken storage (throws) still returns a usable key instead of failing the checkout", () => {
    const broken = {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("private mode");
      },
      removeItem: () => {
        throw new Error("private mode");
      },
    } as unknown as Storage;
    const key = getOrCreateIdempotencyKey(broken);
    expect(key).toMatch(UUID_RE);
  });
});

test.describe("clearIdempotencyKey", () => {
  test("removes the key so the NEXT call generates a fresh one (a later, separate order)", () => {
    const storage = fakeStorage();
    const first = getOrCreateIdempotencyKey(storage);
    clearIdempotencyKey(storage);
    const second = getOrCreateIdempotencyKey(storage);
    expect(second).not.toBe(first);
  });

  test("is a harmless no-op on a broken storage", () => {
    const broken = {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("private mode");
      },
      removeItem: () => {
        throw new Error("private mode");
      },
    } as unknown as Storage;
    expect(() => clearIdempotencyKey(broken)).not.toThrow();
  });
});
