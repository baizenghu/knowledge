/**
 * Global test setup for the standalone knowledge service.
 * Referenced by services/knowledge/vitest.config.ts via `../../tests/setup.ts`.
 *
 * The knowledge service tests run entirely against in-memory stores and mock
 * adapters, so no real database / model endpoints are required here.
 */
import { afterAll, vi } from "vitest";

afterAll(() => {
  vi.restoreAllMocks();
});
