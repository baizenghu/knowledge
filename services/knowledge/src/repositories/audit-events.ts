import type { TenantScope } from "./tenant-scope.js";
import { requireTenantScope } from "./tenant-scope.js";

export type KnowledgeAuditEventInput = TenantScope & {
  userId?: string | null;
  requestId?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  success?: boolean;
  details?: Record<string, unknown>;
  errorCode?: string | null;
  durationMs?: number | null;
  createdAt?: Date;
};

/** Persisted shape returned by audit list queries: includes the populated createdAt. */
export type KnowledgeAuditEventRecord = KnowledgeAuditEventInput & { createdAt: Date };

export type ListAuditEventsInput = {
  actions?: string[];
  resourceType?: string;
  resourceId?: string;
  limit?: number;
  /** Opaque cursor — implementation-defined (in-memory: index; Prisma: createdAt|id). */
  cursor?: string | null;
};

export interface KnowledgeAuditEventWriter {
  write(event: KnowledgeAuditEventInput): Promise<void>;
  writeMany(events: KnowledgeAuditEventInput[]): Promise<void>;
  /**
   * List audit events for one tenant, newest first. Optional filter by action set / resource.
   * Pagination uses an opaque string cursor.
   */
  list(
    scope: TenantScope,
    input?: ListAuditEventsInput,
  ): Promise<{ items: KnowledgeAuditEventRecord[]; nextCursor: string | null }>;
}

export class InMemoryKnowledgeAuditEventWriter implements KnowledgeAuditEventWriter {
  private readonly events: KnowledgeAuditEventInput[] = [];
  private readonly maxDetailsBytes: number;

  constructor(options: { maxDetailsBytes?: number } = {}) {
    this.maxDetailsBytes = options.maxDetailsBytes ?? 16 * 1024;
  }

  async write(event: KnowledgeAuditEventInput): Promise<void> {
    requireTenantScope(event);
    const details = this.clampDetails(event.details);
    this.events.push({
      ...event,
      details,
      success: event.success ?? true,
      createdAt: event.createdAt ?? new Date(),
    });
  }

  async writeMany(events: KnowledgeAuditEventInput[]): Promise<void> {
    for (const event of events) {
      await this.write(event);
    }
  }

  snapshot(): KnowledgeAuditEventInput[] {
    return this.events.map((event) => ({ ...event }));
  }

  async list(
    scope: TenantScope,
    input: ListAuditEventsInput = {},
  ): Promise<{ items: KnowledgeAuditEventRecord[]; nextCursor: string | null }> {
    const safeScope = requireTenantScope(scope);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const actionSet = input.actions && input.actions.length > 0 ? new Set(input.actions) : null;
    // Newest first. Stable order key = createdAt.getTime() then events[] index for tie-breaks.
    const indexed = this.events
      .map((event, index) => ({ event, index }))
      .filter(
        ({ event }) =>
          event.sourceSystemId === safeScope.sourceSystemId &&
          event.tenantId === safeScope.tenantId &&
          (!actionSet || actionSet.has(event.action)) &&
          (!input.resourceType || event.resourceType === input.resourceType) &&
          (!input.resourceId || event.resourceId === input.resourceId),
      )
      .sort((a, b) => {
        const ta = (a.event.createdAt ?? new Date(0)).getTime();
        const tb = (b.event.createdAt ?? new Date(0)).getTime();
        if (tb !== ta) return tb - ta;
        return b.index - a.index;
      });
    // Cursor encoding: "<createdAtMs>:<originalIndex>" — only entries strictly older are returned.
    let start = 0;
    if (input.cursor) {
      const idx = indexed.findIndex(({ event, index }) => {
        const key = `${(event.createdAt ?? new Date(0)).getTime()}:${index}`;
        return key === input.cursor;
      });
      start = idx >= 0 ? idx + 1 : 0;
    }
    const slice = indexed.slice(start, start + limit);
    const items: KnowledgeAuditEventRecord[] = slice.map(({ event }) => ({
      ...event,
      createdAt: event.createdAt ?? new Date(0),
    }));
    const last = slice.at(-1);
    const nextCursor =
      last && start + slice.length < indexed.length
        ? `${(last.event.createdAt ?? new Date(0)).getTime()}:${last.index}`
        : null;
    return { items, nextCursor };
  }

  private clampDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!details) {
      return undefined;
    }
    const json = JSON.stringify(details);
    if (Buffer.byteLength(json, "utf8") <= this.maxDetailsBytes) {
      return details;
    }
    return {
      truncated: true,
      original_bytes: Buffer.byteLength(json, "utf8"),
    };
  }
}
