import type { KnowledgeErrorCode } from "@octopus/knowledge-contracts";
import type { KnowledgeAnchorStore } from "../repositories/anchor-store.js";
import type { KnowledgeChunkStore } from "../repositories/chunk-store.js";
import type { KnowledgeDocumentStore } from "../repositories/document-store.js";
import type { TenantScope } from "../repositories/tenant-scope.js";
import type { KnowledgeAclVisibilityService } from "./acl-visibility.js";
import type { SearchContext } from "./search-service.js";
import { aclDenyCounter, citationHitCounter, sanitizeLabel } from "../observability/metrics.js";

export type CitationResolverResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: KnowledgeErrorCode; message: string };

const SNIPPET_CHARS = 200;

export type ResolvedCitation = {
  anchor_id: string;
  document_id: string;
  document_title: string;
  chunk_id: string;
  heading_path: string[];
  page: number | null;
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  snippet: string;
};

/**
 * Resolve a citation anchor back to a renderable snippet + document title.
 *
 * Security posture (do not relax without review):
 *  - Wrong scope, missing anchor, missing chunk/document, document deleted,
 *    or ACL-not-readable all collapse to NOT_FOUND. We never reveal *why* the
 *    anchor is unavailable, so anchor ids cannot be probed for existence.
 *  - ACL is re-evaluated at call time so a permission change converges within
 *    the time it takes for the principal write to land (target: 30s).
 */
export class KnowledgeCitationResolver {
  constructor(private readonly deps: {
    anchors: KnowledgeAnchorStore;
    chunks: KnowledgeChunkStore;
    documents: KnowledgeDocumentStore;
    aclVisibility: KnowledgeAclVisibilityService;
  }) {}

  async resolve(
    scope: TenantScope,
    anchorId: string,
    ctx: SearchContext,
    now: Date = new Date(),
  ): Promise<CitationResolverResult<ResolvedCitation>> {
    const tenantLabel = sanitizeLabel(scope.tenantId);
    const anchor = await this.deps.anchors.get(scope, anchorId);
    if (!anchor) {
      citationHitCounter.inc({ tenant_id: tenantLabel, outcome: "not_found" });
      return notFound();
    }
    if (anchor.sourceSystemId !== scope.sourceSystemId || anchor.tenantId !== scope.tenantId) {
      // Belt-and-braces: anchor-store already enforces scope, but in case the
      // backing impl ever changes, never trust an out-of-scope record.
      citationHitCounter.inc({ tenant_id: tenantLabel, outcome: "not_found" });
      return notFound();
    }

    const document = await this.deps.documents.get(scope, anchor.documentId);
    if (!document) {
      citationHitCounter.inc({ tenant_id: tenantLabel, outcome: "not_found" });
      return notFound();
    }
    if (document.status === "deleted" || document.visibilityStatus !== "visible" || document.deletedAt) {
      citationHitCounter.inc({ tenant_id: tenantLabel, outcome: "not_found" });
      return notFound();
    }

    const canRead = await this.deps.aclVisibility.canReadDocument(
      scope,
      anchor.documentId,
      { tenantId: ctx.tenantId, userId: ctx.userId, departments: ctx.departments, roles: ctx.roles },
      now,
    );
    if (!canRead) {
      // ACL-blocked: count separately so we can distinguish "permission denied"
      // from "anchor genuinely missing" without leaking which case to the caller.
      aclDenyCounter.inc({ tenant_id: tenantLabel, stage: "citation_resolve" });
      citationHitCounter.inc({ tenant_id: tenantLabel, outcome: "not_found" });
      return notFound();
    }

    const [chunk] = await this.deps.chunks.getMany(scope, [anchor.chunkId]);
    if (!chunk || chunk.deletedAt || chunk.status === "deleted") {
      citationHitCounter.inc({ tenant_id: tenantLabel, outcome: "not_found" });
      return notFound();
    }

    citationHitCounter.inc({ tenant_id: tenantLabel, outcome: "ok" });
    return {
      ok: true,
      data: {
        anchor_id: anchor.anchorId,
        document_id: anchor.documentId,
        document_title: document.title,
        chunk_id: anchor.chunkId,
        heading_path: anchor.headingPath,
        page: anchor.page,
        bbox: anchor.bbox ?? null,
        snippet: chunk.text.slice(0, SNIPPET_CHARS),
      },
    };
  }
}

function notFound(): { ok: false; code: KnowledgeErrorCode; message: string } {
  return { ok: false, code: "NOT_FOUND", message: "citation not found" };
}
