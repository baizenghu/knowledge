export class InMemoryNonceStore {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  claim(nonceKey: string, nowMs = Date.now()): boolean {
    this.cleanup(nowMs);
    if (this.seen.has(nonceKey)) {
      return false;
    }
    this.seen.set(nonceKey, nowMs + this.ttlMs);
    return true;
  }

  cleanup(nowMs = Date.now()): void {
    for (const [key, expiresAt] of this.seen.entries()) {
      if (expiresAt <= nowMs) {
        this.seen.delete(key);
      }
    }
  }
}
