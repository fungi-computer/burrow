import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
import * as Schema from "effect/Schema";
import {
  createArtifactsRestNamespace,
  type ArtifactsRestOptions,
} from "../src/rest.js";
import {
  createCloudflareArtifacts,
  type CloudflareArtifactsRepositoryMetadata,
  type CloudflareArtifactsRepositoryMetadataStore,
} from "../src/cloudflare.js";

function fixtureFetch(
  handler: (...args: Parameters<typeof fetch>) => Response,
): typeof fetch {
  return (...args) => Promise.resolve(handler(...args));
}

function envelope(result: Schema.Json) {
  if (Array.isArray(result))
    return Response.json({
      success: true,
      errors: [],
      result,
      result_info: { total_pages: 1, total_count: result.length },
    });
  return Response.json({ success: true, errors: [], result });
}

test("a newly created repository's initial token is revoked by its listed ID before metadata is returned", async () => {
  const calls: string[] = [];
  let revoked = false;
  let exists = false;
  const options: ArtifactsRestOptions = {
    accountId: "fixture-account",
    namespace: "default",
    apiToken: "fixture-control-token",
    fetch: fixtureFetch((input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      expect(init?.redirect).toBe("manual");
      if (url.pathname.endsWith("/repos") && init?.method !== "POST") {
        return envelope(
          exists
            ? [
                {
                  id: "repo-id",
                  name: "new-repo",
                  default_branch: "main",
                  remote:
                    "https://fixture-account.artifacts.cloudflare.net/git/default/new-repo.git",
                  status: "ready",
                },
              ]
            : [],
        );
      }
      if (url.pathname.endsWith("/repos/new-repo")) {
        if (!exists)
          return Response.json(
            {
              success: false,
              errors: [{ code: 10200, message: "Missing" }],
              result: null,
            },
            { status: 404 },
          );
        return envelope({
          id: "repo-id",
          name: "new-repo",
          default_branch: "main",
          remote:
            "https://fixture-account.artifacts.cloudflare.net/git/default/new-repo.git",
        });
      }
      if (url.pathname.endsWith("/repos")) {
        exists = true;
        return envelope({
          id: "repo-id",
          name: "new-repo",
          default_branch: "main",
          remote:
            "https://fixture-account.artifacts.cloudflare.net/git/default/new-repo.git",
          token: "fixture-initial-token",
        });
      }
      if (url.pathname.endsWith("/repos/new-repo/tokens")) {
        return envelope([
          { id: "initial-id", state: revoked ? "revoked" : "active" },
        ]);
      }
      if (url.pathname.endsWith("/tokens/initial-id")) {
        revoked = true;
        return envelope({ id: "initial-id" });
      }
      throw new Error("Unexpected fixture request");
    }),
  };
  const namespace = createArtifactsRestNamespace(options);
  type PendingRecord = {
    value: Awaited<
      ReturnType<CloudflareArtifactsRepositoryMetadataStore["readPending"]>
    >;
  };
  const recorded: PendingRecord = { value: null };
  let initialRevocationReference: string | undefined;
  let metadata: CloudflareArtifactsRepositoryMetadata | null = null;
  let pending: Awaited<
    ReturnType<CloudflareArtifactsRepositoryMetadataStore["readPending"]>
  > = null;
  const repositories: CloudflareArtifactsRepositoryMetadataStore = {
    read: () => Promise.resolve(metadata),
    readPending: () => Promise.resolve(pending),
    recordPending: (value, initialToken) => {
      initialRevocationReference = initialToken;
      pending = { metadata: value, initialToken };
      recorded.value = pending;
      return Promise.resolve();
    },
    activate: (value) => {
      metadata = value;
      pending = null;
      return Promise.resolve();
    },
  };
  const artifacts = createCloudflareArtifacts({ namespace, repositories });
  const created = await artifacts.ensureRepository("new-repo");
  expect(created).toEqual({
    id: "repo-id",
    name: "new-repo",
    defaultBranch: "main",
  });
  expect(revoked).toBe(true);
  expect(initialRevocationReference).toBe("initial-id");
  expect(calls.filter((call) => call.includes("/tokens"))).toEqual([
    "GET /client/v4/accounts/fixture-account/artifacts/namespaces/default/repos/new-repo/tokens",
    "DELETE /client/v4/accounts/fixture-account/artifacts/namespaces/default/tokens/initial-id",
    "GET /client/v4/accounts/fixture-account/artifacts/namespaces/default/repos/new-repo/tokens",
  ]);
  // Reopen a persisted pending record using a new transport, with no token map.
  if (recorded.value === null)
    throw new Error("Pending fixture was not recorded");
  pending = recorded.value;
  metadata = null;
  const restarted = createCloudflareArtifacts({
    namespace: createArtifactsRestNamespace(options),
    repositories,
  });
  expect(await restarted.ensureRepository("new-repo")).toEqual(created);
  expect(
    calls.filter((call) => call.startsWith("POST ") && call.endsWith("/repos")),
  ).toHaveLength(1);
  expect(calls.filter((call) => call.startsWith("DELETE "))).toEqual([
    "DELETE /client/v4/accounts/fixture-account/artifacts/namespaces/default/tokens/initial-id",
    "DELETE /client/v4/accounts/fixture-account/artifacts/namespaces/default/tokens/initial-id",
  ]);
});

for (const tokens of [
  [],
  [
    { id: "initial-id", state: "active" },
    { id: "another-id", state: "active" },
  ],
]) {
  test(`ambiguous initial tokens (${String(tokens.length)}) clean only the newly created destination`, async () => {
    const deleted: string[] = [];
    const namespace = createArtifactsRestNamespace({
      accountId: "fixture-account",
      namespace: "default",
      apiToken: "fixture-control-token",
      fetch: fixtureFetch((input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (init?.method === "DELETE") {
          deleted.push(url.pathname);
          return envelope({ id: "repo-id" });
        }
        if (url.pathname.endsWith("/tokens")) return envelope(tokens);
        return envelope({
          id: "repo-id",
          name: "new-repo",
          default_branch: "main",
          remote:
            "https://fixture-account.artifacts.cloudflare.net/git/default/new-repo.git",
          token: "fixture-initial-token",
        });
      }),
    });
    await expect(
      namespace.create("new-repo", {
        readOnly: false,
        setDefaultBranch: "main",
      }),
    ).rejects.toThrow("initial token cleanup");
    expect(deleted).toEqual([
      "/client/v4/accounts/fixture-account/artifacts/namespaces/default/repos/new-repo",
    ]);
  });
}

test("an unverified revocation cleans the new fork without deleting its source", async () => {
  const deleted: string[] = [];
  const namespace = createArtifactsRestNamespace({
    accountId: "fixture-account",
    namespace: "default",
    apiToken: "fixture-control-token",
    fetch: fixtureFetch((input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (init?.method === "DELETE") {
        deleted.push(url.pathname);
        return envelope({ id: "initial-id" });
      }
      if (url.pathname.endsWith("/tokens"))
        return envelope([{ id: "initial-id", state: "active" }]);
      const name = url.pathname.endsWith("/fork") ? "new-repo" : "source";
      return envelope({
        id: `repo-${name}`,
        name,
        default_branch: "main",
        remote: `https://fixture-account.artifacts.cloudflare.net/git/default/${name}.git`,
        token: "fixture-initial-token",
      });
    }),
  });
  const source = await namespace.get("source");
  await expect(
    source.fork("new-repo", { readOnly: false, defaultBranchOnly: false }),
  ).rejects.toThrow("initial token cleanup");
  expect(deleted).toEqual([
    "/client/v4/accounts/fixture-account/artifacts/namespaces/default/tokens/initial-id",
    "/client/v4/accounts/fixture-account/artifacts/namespaces/default/repos/new-repo",
  ]);
});

test("an existing destination refusal never cleans up a repository", async () => {
  let calls = 0;
  const namespace = createArtifactsRestNamespace({
    accountId: "fixture-account",
    namespace: "default",
    apiToken: "fixture-control-token",
    fetch: fixtureFetch(() => {
      calls += 1;
      return Response.json(
        {
          success: false,
          result: null,
          errors: [
            { code: 10201, message: "fixture-control-token must not escape" },
          ],
        },
        { status: 409 },
      );
    }),
  });
  await expect(
    namespace.create("existing", { readOnly: false, setDefaultBranch: "main" }),
  ).rejects.toMatchObject({
    code: "ALREADY_EXISTS",
    message: "Artifacts request failed (409)",
  });
  expect(calls).toBe(1);
});

for (const status of [302, 307, 503]) {
  test(`HTTP ${String(status)} cannot produce a successful control-plane result`, async () => {
    let calls = 0;
    const namespace = createArtifactsRestNamespace({
      accountId: "fixture-account",
      namespace: "default",
      apiToken: "fixture-control-token",
      fetch: fixtureFetch((_input, init) => {
        calls += 1;
        expect(init?.redirect).toBe("manual");
        return Response.json(
          { success: true, result: [], errors: [] },
          { status, headers: { location: "https://other.invalid" } },
        );
      }),
    });
    await expect(namespace.list()).rejects.toThrow(
      /Artifacts (redirect refused|request failed)/,
    );
    expect(calls).toBe(1);
  });
}

test("a partial token page cannot establish exactly one initial credential", async () => {
  const deleted: string[] = [];
  const namespace = createArtifactsRestNamespace({
    accountId: "fixture-account",
    namespace: "default",
    apiToken: "fixture-control-token",
    fetch: fixtureFetch((input, init) => {
      const path = new URL(input instanceof Request ? input.url : input)
        .pathname;
      if (init?.method === "DELETE") {
        deleted.push(path);
        return envelope({ id: "repo-id" });
      }
      if (path.endsWith("/tokens"))
        return Response.json({
          success: true,
          errors: [],
          result: [{ id: "initial-id", state: "active" }],
          result_info: { total_pages: 2, total_count: 101 },
        });
      return envelope({
        id: "repo-id",
        name: "new-repo",
        default_branch: "main",
        remote:
          "https://fixture-account.artifacts.cloudflare.net/git/default/new-repo.git",
        token: "fixture-initial-token",
      });
    }),
  });
  await expect(
    namespace.create("new-repo", { readOnly: false, setDefaultBranch: "main" }),
  ).rejects.toThrow("initial token cleanup");
  expect(deleted).toEqual([
    "/client/v4/accounts/fixture-account/artifacts/namespaces/default/repos/new-repo",
  ]);
});

test("malformed provider envelopes cannot expose their contents in an error", async () => {
  const namespace = createArtifactsRestNamespace({
    accountId: "fixture-account",
    namespace: "default",
    apiToken: "fixture-control-token",
    fetch: fixtureFetch(() =>
      Response.json({
        success: "fixture-private-response",
        result: null,
        errors: [],
      }),
    ),
  });
  await expect(namespace.list()).rejects.toMatchObject({
    code: "INVALID_RESPONSE",
    message: "Artifacts returned an invalid response",
  });
});

test("repository handles defer HTTP until info and use one call at 500ms provider latency", async () => {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(request.url ?? "");
    setTimeout(() => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          success: true,
          errors: [],
          result: {
            id: "repo-id",
            name: "source",
            default_branch: "main",
            remote:
              "https://fixture.artifacts.cloudflare.net/git/default/source.git",
          },
        }),
      );
    }, 500);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = Schema.decodeUnknownSync(
      Schema.Struct({ port: Schema.Number }),
    )(server.address());
    const namespace = createArtifactsRestNamespace({
      accountId: "fixture-account",
      namespace: "default",
      apiToken: "fixture-control-token",
      fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        return fetch(
          `http://127.0.0.1:${String(address.port)}${url.pathname}`,
          init,
        );
      },
    });
    const started = performance.now();
    const repo = await namespace.get("source");
    const acquisitionCalls = calls.length;
    expect((await repo.info()).name).toBe("source");
    expect(calls).toEqual([
      "/client/v4/accounts/fixture-account/artifacts/namespaces/default/repos/source",
    ]);
    expect(acquisitionCalls).toBe(0);
    expect(performance.now() - started).toBeGreaterThanOrEqual(500);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("a lazy handle checks current existence and authority on each operation", async () => {
  let status = 200;
  let calls = 0;
  const namespace = createArtifactsRestNamespace({
    accountId: "fixture-account",
    namespace: "default",
    apiToken: "fixture-control-token",
    fetch: fixtureFetch(() => {
      calls += 1;
      if (status !== 200)
        return Response.json(
          {
            success: false,
            result: null,
            errors: [
              { code: status === 404 ? 10200 : 10203, message: "refused" },
            ],
          },
          { status },
        );
      return envelope({
        id: "repo-id",
        name: "source",
        default_branch: "main",
        remote:
          "https://fixture.artifacts.cloudflare.net/git/default/source.git",
      });
    }),
  });
  const repo = await namespace.get("source");
  expect(calls).toBe(0);
  await repo.info();
  status = 404;
  await expect(repo.info()).rejects.toMatchObject({ code: "NOT_FOUND" });
  status = 403;
  await expect(repo.createToken("read", 60)).rejects.toThrow(
    "Artifacts request failed (403)",
  );
  expect(calls).toBe(3);
});
