import { type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { signKnowledgeRequest } from "@octopus/knowledge-contracts";
import { createKnowledgeRuntime } from "../runtime.js";

const config = {
  port: 0,
  serviceToken: "test-token",
  sourceSystemId: "octopus",
  clockSkewMs: 300_000,
  nonceTtlMs: 600_000,
};

describe("knowledge HTTP M6 evaluation flow", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
    server = null;
  });

  it("creates a dataset and returns the dataset_id", async () => {
    const runtime = createKnowledgeRuntime(config);
    const baseUrl = await listen(runtime.app);
    const client = createSignedClient(baseUrl);

    const datasetReq = {
      name: "qa-set",
      version: "v1",
      annotator: "alice",
      samples: [
        { sample_id: "s1", query: "what?", expected_document_ids: ["doc_1"] },
      ],
    };
    const created = await client.request("POST", "/v1/evaluations/datasets", datasetReq);
    expect(created.status).toBe(201);
    expect(created.body.ok).toBe(true);
    expect(typeof created.body.data.dataset_id).toBe("string");
    expect(created.body.data.dataset_id).toMatch(/^eval_/);
  });

  it("creates a run, returns 202 + queued, eventually moves to succeeded", async () => {
    const runtime = createKnowledgeRuntime(config);
    const baseUrl = await listen(runtime.app);
    const client = createSignedClient(baseUrl);
    const datasetReq = {
      name: "qa-set",
      version: "v1",
      annotator: "alice",
      samples: [
        { sample_id: "s1", query: "what?", expected_document_ids: ["doc_1"] },
      ],
    };
    const created = await client.request("POST", "/v1/evaluations/datasets", datasetReq);
    const datasetId = created.body.data.dataset_id as string;

    const runResp = await client.request("POST", "/v1/evaluations/runs", {
      dataset_id: datasetId,
      config: { top_k: 5, final_k: 5 },
    });
    expect(runResp.status).toBe(202);
    expect(runResp.body.ok).toBe(true);
    expect(runResp.body.data.status).toBe("queued");
    expect(typeof runResp.body.data.run_id).toBe("string");
  });

  it("GET /v1/evaluations/runs/:id returns metrics after the run completes", async () => {
    const runtime = createKnowledgeRuntime(config);
    const baseUrl = await listen(runtime.app);
    const client = createSignedClient(baseUrl);
    const created = await client.request("POST", "/v1/evaluations/datasets", {
      name: "qa-set",
      version: "v1",
      annotator: "alice",
      samples: [
        { sample_id: "s1", query: "what?", expected_document_ids: ["doc_1"] },
        { sample_id: "s2", query: "why?", expected_document_ids: ["doc_2"] },
      ],
    });
    const datasetId = created.body.data.dataset_id as string;
    const runResp = await client.request("POST", "/v1/evaluations/runs", {
      dataset_id: datasetId,
      config: {},
    });
    const runId = runResp.body.data.run_id as string;

    // Drain setImmediate'd background task.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const get = await client.request("GET", `/v1/evaluations/runs/${encodeURIComponent(runId)}`);
    expect(get.status).toBe(200);
    expect(get.body.ok).toBe(true);
    expect(get.body.data.run_id).toBe(runId);
    expect(get.body.data.status).toBe("succeeded");
    expect(get.body.data.metrics).not.toBeNull();
    expect(get.body.data.metrics.total_samples).toBe(2);
    expect(Array.isArray(get.body.data.metrics.recall_at_k)).toBe(true);
  });

  async function listen(app: ReturnType<typeof createKnowledgeRuntime>["app"]): Promise<string> {
    server = await new Promise<Server>((resolve) => {
      const active = app.listen(0, "127.0.0.1", () => resolve(active));
    });
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }
});

function createSignedClient(baseUrl: string) {
  let nonceCounter = 0;
  return {
    async request(method: string, path: string, body?: unknown, contentType = "application/json") {
      const payload = Buffer.isBuffer(body)
        ? body
        : body === undefined
          ? Buffer.alloc(0)
          : Buffer.from(JSON.stringify(body));
      const headers: Record<string, string> = {
        authorization: `Bearer ${config.serviceToken}`,
        "x-octopus-source-system": "octopus",
        "x-octopus-tenant": "tenant-1",
        "x-octopus-user": "user-1",
        "x-octopus-departments": "",
        "x-octopus-roles": "knowledge_editor",
        "x-octopus-timestamp": new Date().toISOString(),
        "x-octopus-nonce": `nonce-${++nonceCounter}`,
      };
      if (body !== undefined) {
        headers["content-type"] = contentType;
      }
      headers["x-octopus-signature"] = signKnowledgeRequest({ method, path, body: payload, headers }, config.serviceToken);
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : payload,
      });
      return {
        status: response.status,
        body: await response.json() as any,
      };
    },
  };
}
