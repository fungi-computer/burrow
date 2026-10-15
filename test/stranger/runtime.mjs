import assert from "node:assert/strict";
import {
  createCloudflareArtifacts,
  createArtifactsRestNamespace,
} from "@fungi.computer/burrow";
import { createCloudflareArtifacts as cloudflareArtifacts } from "@fungi.computer/burrow/cloudflare";

assert.equal(createCloudflareArtifacts, cloudflareArtifacts);
const rest = createArtifactsRestNamespace({
  accountId: "fixture-account",
  namespace: "default",
  apiToken: "fixture-only",
  fetch: async (_input, init) => {
    assert.equal(init.redirect, "manual");
    return globalThis.Response.json({
      success: true,
      errors: [],
      result: [],
      result_info: { total_pages: 1, total_count: 0 },
    });
  },
});
assert.deepEqual(await rest.list(), { repos: [], total: 0 });
const metadata = {
  id: "repository-notes",
  name: "notes",
  defaultBranch: "main",
  remote: "https://fixture.artifacts.cloudflare.net/git/fixture/notes.git",
  parentRepository: null,
};
const revoked = [];
const host = createCloudflareArtifacts({
  namespace: {
    list: async () => ({
      repos: [{ name: "notes", status: "ready" }],
      total: 1,
    }),
    get: async () => ({
      createToken: async () => ({
        id: "fixture-token",
        plaintext: "fixture-only",
        expiresAt: "2030-01-01T00:00:00Z",
      }),
      revokeToken: async (id) => {
        revoked.push(id);
        return true;
      },
      fork: async () => assert.fail("resolve and read never fork"),
    }),
    create: async () => assert.fail("an existing repository is not recreated"),
  },
  repositories: {
    read: async () => metadata,
    readPending: async () => null,
    recordPending: async () => assert.fail("read does not stage metadata"),
    activate: async () => assert.fail("read does not activate metadata"),
  },
  gitFetch: async (url, init) => {
    assert.equal(
      url.href,
      "https://fixture.artifacts.cloudflare.net/git/fixture/notes.git/info/refs?service=git-upload-pack",
    );
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    return new globalThis.Response("0000", {
      headers: {
        "content-type": "application/x-git-upload-pack-advertisement",
      },
    });
  },
});
assert.deepEqual(await host.resolveRepository("notes"), {
  id: "repository-notes",
  name: "notes",
  defaultBranch: "main",
});
const response = await host.exchangeGit({
  repository: "notes",
  operation: "upload-pack-advertisement",
});
assert.equal(await response.text(), "0000");
assert.deepEqual(revoked, ["fixture-token"]);
globalThis.console.log(
  "Burrow packed root/cloudflare consumer: repository identity and read-token cleanup PASS",
);
