export type KnowledgeContext = {
  sourceSystemId: string;
  tenantId: string;
  userId: string;
  departments: string[];
  roles: string[];
  agentId?: string;
  sessionId?: string;
  requestId?: string;
  contextDegraded: boolean;
};

export const KNOWLEDGE_CONTEXT_HEADERS = {
  sourceSystemId: "x-octopus-source-system",
  tenantId: "x-octopus-tenant",
  userId: "x-octopus-user",
  departments: "x-octopus-departments",
  roles: "x-octopus-roles",
  agentId: "x-octopus-agent",
  sessionId: "x-octopus-session",
  requestId: "x-octopus-request-id",
  contextDegraded: "x-octopus-context-degraded",
} as const;

export function normalizeContextList(values: unknown): string[] {
  if (Array.isArray(values)) {
    return values.map((value) => String(value).trim()).filter(Boolean).sort();
  }
  if (typeof values === "string") {
    return values.split(",").map((value) => value.trim()).filter(Boolean).sort();
  }
  return [];
}

export function requireKnowledgeContext(input: Partial<KnowledgeContext>): KnowledgeContext {
  const sourceSystemId = input.sourceSystemId?.trim() || "octopus";
  const tenantId = input.tenantId?.trim();
  const userId = input.userId?.trim();
  if (!tenantId) {
    throw new Error("knowledge context missing tenant_id");
  }
  if (!userId) {
    throw new Error("knowledge context missing user_id");
  }
  return {
    sourceSystemId,
    tenantId,
    userId,
    departments: normalizeContextList(input.departments),
    roles: normalizeContextList(input.roles),
    agentId: input.agentId?.trim() || undefined,
    sessionId: input.sessionId?.trim() || undefined,
    requestId: input.requestId?.trim() || undefined,
    contextDegraded: input.contextDegraded === true,
  };
}

export function contextToHeaders(context: KnowledgeContext): Record<string, string> {
  return {
    [KNOWLEDGE_CONTEXT_HEADERS.sourceSystemId]: context.sourceSystemId,
    [KNOWLEDGE_CONTEXT_HEADERS.tenantId]: context.tenantId,
    [KNOWLEDGE_CONTEXT_HEADERS.userId]: context.userId,
    [KNOWLEDGE_CONTEXT_HEADERS.departments]: context.departments.join(","),
    [KNOWLEDGE_CONTEXT_HEADERS.roles]: context.roles.join(","),
    [KNOWLEDGE_CONTEXT_HEADERS.agentId]: context.agentId ?? "",
    [KNOWLEDGE_CONTEXT_HEADERS.sessionId]: context.sessionId ?? "",
    [KNOWLEDGE_CONTEXT_HEADERS.requestId]: context.requestId ?? "",
    [KNOWLEDGE_CONTEXT_HEADERS.contextDegraded]: context.contextDegraded ? "true" : "false",
  };
}
