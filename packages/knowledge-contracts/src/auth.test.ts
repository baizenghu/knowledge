import { describe, expect, it } from "vitest";
import {
  buildCanonicalRequest,
  buildSignedHeaderBlock,
  signKnowledgeRequest,
  verifyKnowledgeSignature,
} from "./auth.js";

describe("knowledge request signing", () => {
  it("signs every X-Octopus header except signature in sorted order", () => {
    const headers = {
      "x-octopus-user": "user-1",
      "x-octopus-signature": "ignored",
      "x-octopus-roles": "knowledge_editor,admin",
      "x-octopus-tenant": "tenant-1",
      "x-octopus-departments": "dept-a",
      "x-octopus-timestamp": "2026-05-18T00:00:00.000Z",
      "x-octopus-nonce": "nonce-1",
    };

    expect(buildSignedHeaderBlock(headers)).toBe([
      "x-octopus-departments:dept-a",
      "x-octopus-nonce:nonce-1",
      "x-octopus-roles:knowledge_editor,admin",
      "x-octopus-tenant:tenant-1",
      "x-octopus-timestamp:2026-05-18T00:00:00.000Z",
      "x-octopus-user:user-1",
    ].join("\n"));
  });

  it("changes signature when an ACL-bearing header is modified", () => {
    const input = {
      method: "POST",
      path: "/v1/search",
      body: JSON.stringify({ query: "test" }),
      headers: {
        "x-octopus-tenant": "tenant-1",
        "x-octopus-user": "user-1",
        "x-octopus-roles": "reader",
        "x-octopus-timestamp": "2026-05-18T00:00:00.000Z",
        "x-octopus-nonce": "nonce-1",
      },
    };
    const signature = signKnowledgeRequest(input, "secret");

    expect(verifyKnowledgeSignature(input, "secret", signature)).toBe(true);
    expect(verifyKnowledgeSignature({
      ...input,
      headers: { ...input.headers, "x-octopus-roles": "admin" },
    }, "secret", signature)).toBe(false);
  });

  it("canonicalizes method, path, body hash, and signed headers", () => {
    expect(buildCanonicalRequest({
      method: "post",
      path: "/v1/spaces",
      body: "{}",
      headers: {
        "x-octopus-tenant": "tenant-1",
        "x-octopus-user": "user-1",
      },
    })).toContain("POST\n/v1/spaces\n");
  });
});
