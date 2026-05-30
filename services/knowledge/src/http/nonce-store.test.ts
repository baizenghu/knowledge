import { describe, expect, it } from "vitest";
import { InMemoryNonceStore } from "./nonce-store.js";

describe("InMemoryNonceStore", () => {
  it("rejects replay until ttl expires", () => {
    const store = new InMemoryNonceStore(100);
    expect(store.claim("tenant:user:nonce", 1000)).toBe(true);
    expect(store.claim("tenant:user:nonce", 1001)).toBe(false);
    expect(store.claim("tenant:user:nonce", 1101)).toBe(true);
  });
});
