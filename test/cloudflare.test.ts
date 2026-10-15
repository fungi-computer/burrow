import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import {
  ArtifactsForkStuckError,
  createCloudflareArtifacts,
  type CloudflareArtifactsRepositoryMetadataStore,
  type CloudflareArtifactsNamespace,
} from "../src/cloudflare.js";
import type { CloudflareArtifactsRepositoryMetadata } from "../src/cloudflare.js";

type Call =
  | Readonly<{ operation: "get"; name: string }>
  | Readonly<{
      operation: "create";
      name: string;
      options: Parameters<CloudflareArtifactsNamespace["create"]>[1];
    }>
  | Readonly<{
      operation: "raced-create";
      name: string;
      options: Parameters<CloudflareArtifactsNamespace["create"]>[1];
    }>
  | Readonly<{ operation: "revoke"; name: string }>
  | Readonly<{ operation: "record-pending"; name: string }>
  | Readonly<{ operation: "activate"; name: string }>
  | Readonly<{
      operation: "token";
      name: string;
      scope: "read" | "write";
      ttl: number | undefined;
    }>
  | Readonly<{ operation: "fork"; name: string; target: string }>
  | Readonly<{
      url: string;
      method: string | undefined;
      redirect: RequestInit["redirect"];
      authorization: string | null;
      contentType: string | null;
      accept: string | null;
    }>;

const packetLine = (payload: string) =>
  `${(new TextEncoder().encode(payload).byteLength + 4).toString(16).padStart(4, "0")}${payload}`;

async function withGitAdvertisement(
  refs: readonly Readonly<{ ref: string; oid: string }>[],
  run: (
    requests: readonly Readonly<{
      method: string;
      path: string;
      authorization: string | null;
    }>[],
  ) => Promise<void>,
  status = 200,
  refsForPath?: (
    path: string,
  ) => readonly Readonly<{ ref: string; oid: string }>[],
) {
  const requests: {
    method: string;
    path: string;
    authorization: string | null;
  }[] = [];
  const capabilities =
    packetLine("version 2\n") +
    packetLine("agent=artifacts-fixture\n") +
    packetLine("ls-refs=unborn\n") +
    packetLine("fetch=shallow wait-for-done\n") +
    "0000";
  const refResponse = (path: string) => {
    const selected = refsForPath?.(path) ?? refs;
    return (
      selected.map((ref) => packetLine(`${ref.oid} ${ref.ref}\n`)).join("") +
      "0000"
    );
  };
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "GET",
      path: request.url ?? "",
      authorization: request.headers.authorization ?? null,
    });
    response.writeHead(status, {
      "content-type":
        request.method === "GET"
          ? "application/x-git-upload-pack-advertisement"
          : "application/x-git-upload-pack-result",
    });
    response.end(
      request.method === "GET" ? capabilities : refResponse(request.url ?? ""),
    );
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null)
    throw new Error("Local Git fixture did not bind a TCP port");
  // SAFETY: listen() bound this fixture to an IPv4 TCP address, not a pipe.
  const tcpAddress = address as AddressInfo;
  const origin = `http://127.0.0.1:${tcpAddress.port.toString()}`;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal(
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const remote = new URL(request.url);
      return nativeFetch(
        new Request(new URL(remote.pathname + remote.search, origin), request),
      );
    },
  );
  try {
    await run(requests);
  } finally {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
}

function cloudflareError(code: string, numericCode: number): Error {
  return Object.assign(new Error(code), { code, numericCode });
}

function fakeNamespace() {
  const repositories = new Map<
    string,
    { id: string; name: string; remote: string; source: string | null }
  >();
  const notReadyLookups = new Map<string, number>();
  const notReadyStatuses = new Map<string, "importing" | "forking">();
  const calls: Call[] = [];
  const metadata = new Map<string, CloudflareArtifactsRepositoryMetadata>();
  const pending = new Map<
    string,
    {
      metadata: CloudflareArtifactsRepositoryMetadata;
      initialToken: string;
    }
  >();
  let recordFailures = 0;
  let revokeFailures = 0;
  let pendingWriteGate:
    Readonly<{ entered(): void; wait: Promise<void> }> | undefined;
  let pendingWriteAfterSaveGate:
    Readonly<{ entered(): void; wait: Promise<void> }> | undefined;
  let initialLookupGate:
    | Readonly<{
        name: string;
        expected: number;
        entered(): void;
        wait: Promise<void>;
      }>
    | undefined;
  let initialLookupCount = 0;
  let notifyRacedCreate!: () => void;
  const racedCreate = new Promise<void>((resolve) => {
    notifyRacedCreate = resolve;
  });
  const repositoriesStore: CloudflareArtifactsRepositoryMetadataStore = {
    read: (name) =>
      Promise.resolve(pending.has(name) ? null : (metadata.get(name) ?? null)),
    readPending: (name) => Promise.resolve(pending.get(name) ?? null),
    recordPending: async (value, initialToken) => {
      const gate = pendingWriteGate;
      if (gate !== undefined) {
        pendingWriteGate = undefined;
        gate.entered();
        await gate.wait;
      }
      if (recordFailures > 0) {
        recordFailures -= 1;
        throw new Error("D1 write unavailable");
      }
      const existing = metadata.get(value.name);
      if (
        existing !== undefined &&
        JSON.stringify(existing) !== JSON.stringify(value)
      )
        throw new Error("metadata conflict");
      const existingPending = pending.get(value.name);
      if (
        existingPending !== undefined &&
        (JSON.stringify(existingPending.metadata) !== JSON.stringify(value) ||
          existingPending.initialToken !== initialToken)
      )
        throw new Error("pending metadata conflict");
      if (existing === undefined)
        pending.set(value.name, { metadata: value, initialToken });
      calls.push({ operation: "record-pending", name: value.name });
      const afterSaveGate = pendingWriteAfterSaveGate;
      if (afterSaveGate !== undefined) {
        pendingWriteAfterSaveGate = undefined;
        afterSaveGate.entered();
        await afterSaveGate.wait;
      }
      return;
    },
    activate: (value, initialToken) => {
      const existingPending = pending.get(value.name);
      const existing = metadata.get(value.name);
      if (
        existingPending === undefined ||
        JSON.stringify(existingPending.metadata) !== JSON.stringify(value) ||
        existingPending.initialToken !== initialToken ||
        (existing !== undefined &&
          JSON.stringify(existing) !== JSON.stringify(value))
      )
        throw new Error("pending activation conflict");
      metadata.set(value.name, value);
      pending.delete(value.name);
      calls.push({ operation: "activate", name: value.name });
      return Promise.resolve();
    },
  };
  const seedRepository = (
    name: string,
    parentRepository: string | null = null,
  ) => {
    const value = repositories.get(name);
    if (!value) throw new Error(`Missing provider fixture: ${name}`);
    metadata.set(name, {
      id: value.id,
      name: value.name,
      defaultBranch: "main",
      remote: value.remote,
      parentRepository,
    });
  };
  const remote = (name: string) =>
    `https://account.artifacts.cloudflare.net/git/default/${name}.git`;
  const namespace = {
    list: () =>
      Promise.resolve({
        repos: [...repositories.values()].map((repository) => {
          const remainingNotReady = notReadyLookups.get(repository.name) ?? 0;
          if (remainingNotReady > 0)
            notReadyLookups.set(repository.name, remainingNotReady - 1);
          const status =
            remainingNotReady > 0
              ? (notReadyStatuses.get(repository.name) ?? "forking")
              : "ready";
          return {
            name: repository.name,
            status,
          };
        }),
        total: repositories.size,
      }),
    get: async (name: string) => {
      calls.push({ operation: "get", name });
      const gate = initialLookupGate;
      if (gate?.name === name) {
        initialLookupCount += 1;
        if (initialLookupCount === gate.expected) {
          initialLookupGate = undefined;
          gate.entered();
        }
        await gate.wait;
      }
      const found = repositories.get(name);
      if (!found) throw cloudflareError("NOT_FOUND", 10200);
      const handle: unknown = Object.create({
        createToken: (scope: "read" | "write", ttl?: number) => {
          calls.push({ operation: "token", name, scope, ttl });
          return Promise.resolve({
            id: `token-${scope}`,
            plaintext: `provider-${scope}-secret`,
            scope,
            expiresAt: "2026-09-24T00:05:00.000Z",
          });
        },
        revokeToken: (tokenOrId: string) => {
          calls.push({ operation: "revoke", name });
          if (revokeFailures > 0) {
            revokeFailures -= 1;
            return Promise.reject(new Error("temporary revoke failure"));
          }
          return Promise.resolve(
            tokenOrId === "discarded" || tokenOrId === "discarded-fork-token"
              ? false
              : true,
          );
        },
        fork: (target: string) => {
          calls.push({ operation: "fork", name, target });
          if (repositories.has(target))
            return Promise.reject(cloudflareError("ALREADY_EXISTS", 10201));
          const forked = {
            id: `id-${target}`,
            name: target,
            remote: remote(target),
            source: `artifacts:default/${name}`,
          };
          repositories.set(target, forked);
          return Promise.resolve({
            id: forked.id,
            name: forked.name,
            remote: forked.remote,
            defaultBranch: "main",
            token: "discarded-fork-token",
          });
        },
      });
      // SAFETY: this fixture exposes exactly the maintained RPC methods and no
      // data properties, matching the opaque Worker binding handle contract.
      return handle as Awaited<ReturnType<CloudflareArtifactsNamespace["get"]>>;
    },
    create: (
      name: string,
      options: Parameters<CloudflareArtifactsNamespace["create"]>[1],
    ) => {
      calls.push({ operation: "create", name, options });
      if (repositories.has(name)) {
        calls.push({ operation: "raced-create", name, options });
        notifyRacedCreate();
        return Promise.reject(cloudflareError("ALREADY_EXISTS", 10201));
      }
      const created = {
        id: `id-${name}`,
        name,
        remote: remote(name),
        source: null,
      };
      repositories.set(name, created);
      return Promise.resolve({
        id: created.id,
        name: created.name,
        remote: created.remote,
        defaultBranch: "main",
        token: "discarded",
        tokenExpiresAt: "",
      });
    },
  };
  return {
    namespace,
    calls,
    repositories,
    repositoriesStore,
    seedRepository,
    setNotReadyLookups: (
      name: string,
      count: number,
      status: "importing" | "forking" = "forking",
    ) => {
      notReadyLookups.set(name, count);
      notReadyStatuses.set(name, status);
    },
    failRecordingOnce: () => {
      recordFailures = 1;
    },
    failRevocationOnce: () => {
      revokeFailures = 1;
    },
    holdNextPendingWrite: () => {
      let release!: () => void;
      let entered!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      pendingWriteGate = { entered, wait };
      return { started, release };
    },
    holdNextPendingWriteAfterSave: () => {
      let release!: () => void;
      let entered!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      pendingWriteAfterSaveGate = { entered, wait };
      return { started, release };
    },
    holdInitialRepositoryLookups: (name: string, expected = 2) => {
      let release!: () => void;
      let entered!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      initialLookupCount = 0;
      initialLookupGate = { name, expected, entered, wait };
      return { started, release };
    },
    racedCreate,
  };
}

function createArtifacts(fake: ReturnType<typeof fakeNamespace>) {
  return createCloudflareArtifacts({
    namespace: fake.namespace,
    repositories: fake.repositoriesStore,
  });
}

it("creates and forks stable repositories without returning provider credentials", async () => {
  await withGitAdvertisement(
    [{ ref: "refs/heads/main", oid: "a".repeat(40) }],
    async (gitRequests) => {
      const fake = fakeNamespace();
      const artifacts = createArtifacts(fake);
      const created = await artifacts.ensureRepository("template-app");
      const handle = await fake.namespace.get("template-app");
      expect(Object.keys(handle)).toEqual([]);
      await expect(
        fake.repositoriesStore.read("template-app"),
      ).resolves.toEqual({
        id: "id-template-app",
        name: "template-app",
        defaultBranch: "main",
        remote:
          "https://account.artifacts.cloudflare.net/git/default/template-app.git",
        parentRepository: null,
      });
      const replayed = await artifacts.ensureRepository("template-app");
      const forked = await artifacts.forkRepository({
        template: created.name,
        repository: "team-app",
        expectedMainHead: "a".repeat(40),
      });
      const replayedFork = await artifacts.forkRepository({
        template: created.name,
        repository: "team-app",
        expectedMainHead: "a".repeat(40),
      });

      expect(created).toEqual({
        id: "id-template-app",
        name: "template-app",
        defaultBranch: "main",
      });
      expect(replayed).toEqual(created);
      expect(forked).toEqual({
        repository: {
          id: "id-team-app",
          name: "team-app",
          defaultBranch: "main",
        },
        mainHead: "a".repeat(40),
        disposition: "created",
      });
      expect(replayedFork).toEqual({
        repository: forked.repository,
        mainHead: "a".repeat(40),
        disposition: "existing",
      });
      expect(
        fake.calls.filter(
          (call) => "operation" in call && call.operation === "fork",
        ),
      ).toHaveLength(1);
      expect(JSON.stringify([created, forked])).not.toContain("provider-");
      expect(JSON.stringify([created, forked])).not.toContain(
        "artifacts.cloudflare.net",
      );
      expect(fake.calls).toContainEqual({
        operation: "create",
        name: "template-app",
        options: { readOnly: false, setDefaultBranch: "main" },
      });
      expect(
        fake.calls.filter(
          (call) => "operation" in call && call.operation === "revoke",
        ),
      ).toHaveLength(5);
      expect(gitRequests.length).toBeGreaterThan(0);
      expect(
        gitRequests.every(
          ({ authorization }) =>
            authorization === "Bearer provider-read-secret",
        ),
      ).toBe(true);
    },
  );
});

it("recovers an exact existing fork after its template advances", async () => {
  const initialHead = "a".repeat(40);
  let templateHead = initialHead;
  await withGitAdvertisement(
    [],
    async () => {
      const fake = fakeNamespace();
      const artifacts = createArtifacts(fake);
      await artifacts.ensureRepository("template-app");
      const created = await artifacts.forkRepository({
        template: "template-app",
        repository: "team-app",
        expectedMainHead: initialHead,
      });

      templateHead = "d".repeat(40);
      await expect(
        artifacts.recoverForkRepository({
          template: "template-app",
          repository: "team-app",
        }),
      ).resolves.toEqual({
        repository: created.repository,
        mainHead: initialHead,
        disposition: "existing",
      });
      await expect(
        artifacts.forkRepository({
          template: "template-app",
          repository: "team-app",
          expectedMainHead: initialHead,
        }),
      ).resolves.toMatchObject({
        mainHead: initialHead,
        disposition: "existing",
      });
      expect(
        fake.calls.filter(
          (call) => "operation" in call && call.operation === "fork",
        ),
      ).toHaveLength(1);
    },
    200,
    (path) => [
      {
        ref: "refs/heads/main",
        oid: path.includes("/team-app.git/") ? initialHead : templateHead,
      },
    ],
  );
});

it("waits through the documented fork readiness error before revoking and recording", async () => {
  const mainHead = "a".repeat(40);
  await withGitAdvertisement(
    [{ ref: "refs/heads/main", oid: mainHead }],
    async () => {
      const fake = fakeNamespace();
      const artifacts = createArtifacts(fake);
      await artifacts.ensureRepository("template-app");
      fake.setNotReadyLookups("team-app", 2);

      await expect(
        artifacts.forkRepository({
          template: "template-app",
          repository: "team-app",
          expectedMainHead: mainHead,
        }),
      ).resolves.toMatchObject({
        repository: { name: "team-app" },
        disposition: "created",
      });
      expect(
        fake.calls.filter(
          (call) => "operation" in call && call.operation === "revoke",
        ),
      ).toContainEqual({ operation: "revoke", name: "team-app" });
      await expect(
        fake.repositoriesStore.read("team-app"),
      ).resolves.toMatchObject({
        id: "id-team-app",
        parentRepository: "template-app",
      });
    },
  );
});

it.each(["upload-pack-advertisement", "receive-pack-advertisement"] as const)(
  "waits for a ready handle before %s when list and get disagree",
  async (operation) => {
    vi.useFakeTimers();
    try {
      const fake = fakeNamespace();
      await createArtifacts(fake).ensureRepository("team-app");
      fake.calls.length = 0;
      let ready = false;
      const namespace: CloudflareArtifactsNamespace = {
        ...fake.namespace,
        get: (name) =>
          ready
            ? fake.namespace.get(name)
            : Promise.reject(cloudflareError("FORK_IN_PROGRESS", 10303)),
      };
      const gitFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null));
      const artifacts = createCloudflareArtifacts({
        namespace,
        repositories: fake.repositoriesStore,
        gitFetch,
      });
      const result = artifacts
        .exchangeGit({ repository: "team-app", operation })
        .then(
          (response) => ({ response }),
          (error: unknown) => ({ error }),
        );
      await vi.advanceTimersByTimeAsync(0);
      expect(gitFetch).not.toHaveBeenCalled();
      expect(fake.calls).toEqual([]);
      ready = true;
      await vi.advanceTimersByTimeAsync(500);
      expect(await result).toHaveProperty("response.status", 200);
      expect(gitFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  },
);

it("bounds a stale-ready handle refusal and preserves the typed last status", async () => {
  vi.useFakeTimers();
  try {
    const fake = fakeNamespace();
    await createArtifacts(fake).ensureRepository("team-app");
    fake.calls.length = 0;
    const get = vi
      .fn<CloudflareArtifactsNamespace["get"]>()
      .mockRejectedValue(cloudflareError("FORK_IN_PROGRESS", 10303));
    const gitFetch = vi.fn<typeof fetch>();
    const artifacts = createCloudflareArtifacts({
      namespace: { ...fake.namespace, get },
      repositories: fake.repositoriesStore,
      gitFetch,
    });
    const result = artifacts
      .exchangeGit({
        repository: "team-app",
        operation: "upload-pack-advertisement",
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await result).toBeInstanceOf(ArtifactsForkStuckError);
    expect(await result).toMatchObject({
      repository: "team-app",
      status: "forking",
    });
    expect(get).toHaveBeenCalledTimes(240);
    expect(gitFetch).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps an asynchronous fork pending until its handle is ready despite list lag", async () => {
  const fake = fakeNamespace();
  await createArtifacts(fake).ensureRepository("template-app");
  const gate = fake.holdNextPendingWriteAfterSave();
  let ready = false;
  const namespace: CloudflareArtifactsNamespace = {
    ...fake.namespace,
    list: async () => {
      const page = await fake.namespace.list();
      return {
        ...page,
        repos: page.repos.filter((repo) => ready || repo.name !== "team-app"),
      };
    },
    get: (name) =>
      name === "team-app" && fake.repositories.has(name) && !ready
        ? Promise.reject(cloudflareError("FORK_IN_PROGRESS", 10303))
        : fake.namespace.get(name),
  };
  vi.stubGlobal(
    "fetch",
    (_input: string | URL | Request, init?: RequestInit) => {
      const advertisement = init?.method !== "POST";
      return Promise.resolve(
        new Response(
          advertisement
            ? packetLine("version 2\n") +
                packetLine("ls-refs=unborn\n") +
                "0000"
            : packetLine(`${"a".repeat(40)} refs/heads/main\n`) + "0000",
          {
            headers: {
              "content-type": advertisement
                ? "application/x-git-upload-pack-advertisement"
                : "application/x-git-upload-pack-result",
            },
          },
        ),
      );
    },
  );
  const artifacts = createCloudflareArtifacts({
    namespace,
    repositories: fake.repositoriesStore,
  });
  vi.useFakeTimers();
  try {
    const result = artifacts
      .forkRepository({
        template: "template-app",
        repository: "team-app",
        expectedMainHead: "a".repeat(40),
      })
      .then(
        (fork) => ({ fork }),
        (error: unknown) => ({ error }),
      );
    await gate.started;
    gate.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      fake.calls.filter(
        (call) => "operation" in call && call.name === "team-app",
      ),
    ).toEqual([
      { operation: "get", name: "team-app" },
      { operation: "record-pending", name: "team-app" },
    ]);
    await expect(fake.repositoriesStore.read("team-app")).resolves.toBe(null);
    ready = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toHaveProperty("fork.repository.name", "team-app");
    await expect(fake.repositoriesStore.readPending("team-app")).resolves.toBe(
      null,
    );
  } finally {
    gate.release();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("exposes a typed stuck-fork result with the last provider status", () => {
  const error = new ArtifactsForkStuckError("team-app", "forking");
  expect(error).toMatchObject({
    name: "ArtifactsForkStuckError",
    repository: "team-app",
    status: "forking",
  });
});

it("reads exactly main through Git HTTP and revokes read tokens on success and failure", async () => {
  await withGitAdvertisement(
    [
      { ref: "refs/heads/main", oid: "d".repeat(40) },
      { ref: "refs/heads/main-copy", oid: "e".repeat(40) },
    ],
    async (requests) => {
      const fake = fakeNamespace();
      fake.repositories.set("template-app", {
        id: "id-template-app",
        name: "template-app",
        remote:
          "https://account.artifacts.cloudflare.net/git/default/template-app.git",
        source: null,
      });
      fake.seedRepository("template-app");
      const artifacts = createArtifacts(fake);
      await expect(
        artifacts.readDefaultBranchHead("template-app"),
      ).resolves.toBe("d".repeat(40));
      expect(requests).toEqual([
        {
          method: "GET",
          path: "/git/default/template-app.git/info/refs?service=git-upload-pack",
          authorization: "Bearer provider-read-secret",
        },
        {
          method: "POST",
          path: "/git/default/template-app.git/git-upload-pack",
          authorization: "Bearer provider-read-secret",
        },
      ]);
      expect(fake.calls).toContainEqual({
        operation: "revoke",
        name: "template-app",
      });
    },
  );

  await withGitAdvertisement(
    [{ ref: "refs/heads/main", oid: "f".repeat(40) }],
    async () => {
      const fake = fakeNamespace();
      fake.repositories.set("template-app", {
        id: "id-template-app",
        name: "template-app",
        remote:
          "https://account.artifacts.cloudflare.net/git/default/template-app.git",
        source: null,
      });
      fake.seedRepository("template-app");
      const artifacts = createArtifacts(fake);
      await expect(
        artifacts.readDefaultBranchHead("template-app"),
      ).rejects.toThrow();
      expect(fake.calls).toContainEqual({
        operation: "revoke",
        name: "template-app",
      });
    },
    503,
  );

  await withGitAdvertisement(
    [{ ref: "refs/heads/main-copy", oid: "e".repeat(40) }],
    async () => {
      const fake = fakeNamespace();
      fake.repositories.set("template-app", {
        id: "id-template-app",
        name: "template-app",
        remote:
          "https://account.artifacts.cloudflare.net/git/default/template-app.git",
        source: null,
      });
      fake.seedRepository("template-app");
      const artifacts = createArtifacts(fake);
      await expect(
        artifacts.readDefaultBranchHead("template-app"),
      ).resolves.toBe(null);
    },
  );

  await withGitAdvertisement(
    [
      { ref: "refs/heads/main", oid: "d".repeat(40) },
      { ref: "refs/heads/main", oid: "e".repeat(40) },
    ],
    async () => {
      const fake = fakeNamespace();
      fake.repositories.set("template-app", {
        id: "id-template-app",
        name: "template-app",
        remote:
          "https://account.artifacts.cloudflare.net/git/default/template-app.git",
        source: null,
      });
      fake.seedRepository("template-app");
      const artifacts = createArtifacts(fake);
      await expect(
        artifacts.readDefaultBranchHead("template-app"),
      ).rejects.toThrow();
      expect(fake.calls).toContainEqual({
        operation: "revoke",
        name: "template-app",
      });
    },
  );
});

it("reads advertised branch heads for App source revision provenance", async () => {
  await withGitAdvertisement(
    [
      { ref: "refs/heads/main", oid: "a".repeat(40) },
      { ref: "refs/heads/proposal", oid: "b".repeat(40) },
    ],
    async () => {
      const fake = fakeNamespace();
      fake.repositories.set("team-app", {
        id: "id-team-app",
        name: "team-app",
        remote:
          "https://account.artifacts.cloudflare.net/git/default/team-app.git",
        source: null,
      });
      fake.seedRepository("team-app");
      const artifacts = createArtifacts(fake);
      await expect(artifacts.readBranchHeads("team-app")).resolves.toEqual([
        "a".repeat(40),
        "b".repeat(40),
      ]);
      expect(fake.calls).toContainEqual({
        operation: "revoke",
        name: "team-app",
      });
    },
  );
});

it("reads named refs through the same short-lived token owner", async () => {
  await withGitAdvertisement(
    [
      { ref: "refs/heads/main", oid: "a".repeat(40) },
      { ref: "refs/heads/proposal", oid: "b".repeat(40) },
      { ref: "refs/tags/reviewed", oid: "c".repeat(40) },
    ],
    async () => {
      const fake = fakeNamespace();
      fake.repositories.set("team-app", {
        id: "id-team-app",
        name: "team-app",
        remote:
          "https://account.artifacts.cloudflare.net/git/default/team-app.git",
        source: null,
      });
      fake.seedRepository("team-app");
      const artifacts = createArtifacts(fake);
      await expect(artifacts.readRefs("team-app")).resolves.toEqual([
        { name: "refs/heads/main", hash: "a".repeat(40) },
        { name: "refs/heads/proposal", hash: "b".repeat(40) },
        { name: "refs/tags/reviewed", hash: "c".repeat(40) },
      ]);
      expect(
        fake.calls.filter(
          (call) => "operation" in call && call.operation === "revoke",
        ),
      ).toEqual([{ operation: "revoke", name: "team-app" }]);
    },
  );
});

it("recovers a repository creation race from Cloudflare's string error code", async () => {
  const fake = fakeNamespace();
  const namespace: CloudflareArtifactsNamespace = {
    ...fake.namespace,
    create: (name, options) => {
      fake.calls.push({ operation: "raced-create", name, options });
      fake.repositories.set(name, {
        id: `id-${name}`,
        name,
        remote: `https://account.artifacts.cloudflare.net/git/default/${name}.git`,
        source: null,
      });
      return Promise.reject(cloudflareError("ALREADY_EXISTS", 10201));
    },
  };
  const artifacts = createCloudflareArtifacts({
    namespace,
    repositories: fake.repositoriesStore,
  });
  await expect(artifacts.ensureRepository("template-app")).rejects.toThrow(
    "Artifacts repository creation race was not recorded",
  );
});

it("retries a documented fork-readiness lookup before pending token cleanup", async () => {
  await withGitAdvertisement(
    [{ ref: "refs/heads/main", oid: "a".repeat(40) }],
    async () => {
      const forkFake = fakeNamespace();
      forkFake.repositories.set("template-app", {
        id: "id-template-app",
        name: "template-app",
        remote:
          "https://account.artifacts.cloudflare.net/git/default/template-app.git",
        source: null,
      });
      forkFake.seedRepository("template-app");
      forkFake.setNotReadyLookups("team-app", 2);
      const forkNamespace: CloudflareArtifactsNamespace = {
        ...forkFake.namespace,
      };
      const forkArtifacts = createCloudflareArtifacts({
        namespace: forkNamespace,
        repositories: forkFake.repositoriesStore,
      });
      await expect(
        forkArtifacts.forkRepository({
          template: "template-app",
          repository: "team-app",
          expectedMainHead: "a".repeat(40),
        }),
      ).resolves.toMatchObject({
        repository: { name: "team-app" },
        disposition: "created",
      });
      expect(
        forkFake.calls.filter(
          (call) => "operation" in call && call.operation === "revoke",
        ),
      ).toContainEqual({ operation: "revoke", name: "team-app" });
    },
  );

  const createFake = fakeNamespace();
  createFake.setNotReadyLookups("template-app", 1, "importing");
  const createNamespace: CloudflareArtifactsNamespace = {
    ...createFake.namespace,
  };
  const createArtifacts = createCloudflareArtifacts({
    namespace: createNamespace,
    repositories: createFake.repositoriesStore,
  });
  await expect(
    createArtifacts.ensureRepository("template-app"),
  ).resolves.toMatchObject({ name: "template-app" });
  expect(
    createFake.calls.filter(
      (call) => "operation" in call && call.operation === "revoke",
    ),
  ).toContainEqual({ operation: "revoke", name: "template-app" });
  await expect(
    createArtifacts.ensureRepository("template-app"),
  ).resolves.toMatchObject({
    name: "template-app",
  });
});

it("persists the exact create result before revocation and retries a transient D1 failure", async () => {
  const fake = fakeNamespace();
  fake.failRecordingOnce();
  const artifacts = createArtifacts(fake);

  await expect(
    artifacts.ensureRepository("template-app"),
  ).resolves.toMatchObject({
    id: "id-template-app",
    name: "template-app",
    defaultBranch: "main",
  });
  const pendingIndex = fake.calls.findIndex(
    (call) => "operation" in call && call.operation === "record-pending",
  );
  const revokeIndex = fake.calls.findIndex(
    (call) => "operation" in call && call.operation === "revoke",
  );
  const activateIndex = fake.calls.findIndex(
    (call) => "operation" in call && call.operation === "activate",
  );
  expect(pendingIndex).toBeGreaterThan(-1);
  expect(revokeIndex).toBeGreaterThan(pendingIndex);
  expect(activateIndex).toBeGreaterThan(revokeIndex);
  await expect(
    fake.repositoriesStore.read("template-app"),
  ).resolves.toMatchObject({
    id: "id-template-app",
    remote:
      "https://account.artifacts.cloudflare.net/git/default/template-app.git",
  });
});

it("returns the creator's exact active metadata when a duplicate promotes first", async () => {
  const fake = fakeNamespace();
  const gate = fake.holdNextPendingWriteAfterSave();
  const artifacts = createArtifacts(fake);
  const creator = artifacts.ensureRepository("template-app");
  await gate.started;

  await expect(artifacts.ensureRepository("template-app")).resolves.toEqual({
    id: "id-template-app",
    name: "template-app",
    defaultBranch: "main",
  });
  expect(
    fake.calls.findIndex(
      (call) => "operation" in call && call.operation === "activate",
    ),
  ).toBeGreaterThan(-1);
  gate.release();

  await expect(creator).resolves.toEqual({
    id: "id-template-app",
    name: "template-app",
    defaultBranch: "main",
  });
  await expect(
    fake.repositoriesStore.readPending("template-app"),
  ).resolves.toBe(null);
});

it("recovers a concurrent ALREADY_EXISTS create while the winner persists pending metadata", async () => {
  const fake = fakeNamespace();
  const lookupGate = fake.holdInitialRepositoryLookups("template-app");
  const pendingGate = fake.holdNextPendingWrite();
  const artifacts = createArtifacts(fake);
  const creating = artifacts.ensureRepository("template-app");
  const duplicate = artifacts.ensureRepository("template-app");
  await lookupGate.started;
  lookupGate.release();
  await pendingGate.started;
  await fake.racedCreate;
  pendingGate.release();

  await expect(Promise.all([creating, duplicate])).resolves.toEqual([
    { id: "id-template-app", name: "template-app", defaultBranch: "main" },
    { id: "id-template-app", name: "template-app", defaultBranch: "main" },
  ]);
  expect(
    fake.calls.filter(
      (call) => "operation" in call && call.operation === "create",
    ),
  ).toHaveLength(2);
  expect(
    fake.calls.filter(
      (call) => "operation" in call && call.operation === "raced-create",
    ),
  ).toHaveLength(1);
  await expect(
    fake.repositoriesStore.readPending("template-app"),
  ).resolves.toBe(null);
});

it("recovers a failed token revoke from exact pending metadata and token", async () => {
  const fake = fakeNamespace();
  fake.failRevocationOnce();
  const artifacts = createArtifacts(fake);

  await expect(artifacts.ensureRepository("template-app")).rejects.toThrow(
    "Artifacts initial token cleanup could not be confirmed",
  );
  await expect(fake.repositoriesStore.read("template-app")).resolves.toBe(null);
  await expect(
    fake.repositoriesStore.readPending("template-app"),
  ).resolves.toMatchObject({
    metadata: {
      id: "id-template-app",
      name: "template-app",
      remote:
        "https://account.artifacts.cloudflare.net/git/default/template-app.git",
    },
    initialToken: "discarded",
  });
  await expect(
    artifacts.ensureRepository("template-app"),
  ).resolves.toMatchObject({
    name: "template-app",
  });
  await expect(
    fake.repositoriesStore.readPending("template-app"),
  ).resolves.toBe(null);
  expect(
    fake.calls.filter(
      (call) => "operation" in call && call.operation === "create",
    ),
  ).toHaveLength(1);
  expect(
    fake.calls.filter(
      (call) => "operation" in call && call.operation === "revoke",
    ),
  ).toHaveLength(2);
});

it("uses read/write scoped short leases for only the closed Git protocol", async () => {
  const fake = fakeNamespace();
  fake.repositories.set("team-app", {
    id: "id-team-app",
    name: "team-app",
    remote: "https://account.artifacts.cloudflare.net/git/default/team-app.git",
    source: null,
  });
  fake.seedRepository("team-app");
  const artifacts = createArtifacts(fake);
  const providerFetch = vi.fn(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      const headers = new Headers(init?.headers);
      fake.calls.push({
        url: url.toString(),
        method: init?.method,
        redirect: init?.redirect,
        authorization: headers.get("authorization"),
        contentType: headers.get("content-type"),
        accept: headers.get("accept"),
      });
      return new Response("git protocol bytes", {
        headers: { "content-type": "application/x-git-upload-pack-result" },
      });
    },
  );
  vi.stubGlobal("fetch", providerFetch);
  try {
    const advertisement = await artifacts.exchangeGit({
      repository: "team-app",
      operation: "upload-pack-advertisement",
    });
    const pushed = await artifacts.exchangeGit({
      repository: "team-app",
      operation: "receive-pack",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("bounded git frame"));
          controller.close();
        },
      }),
    });
    expect(await advertisement.text()).toBe("git protocol bytes");
    expect(await pushed.text()).toBe("git protocol bytes");
    expect(
      fake.calls.find(
        (call) => "url" in call && call.url.includes("info/refs"),
      ),
    ).toMatchObject({
      url: "https://account.artifacts.cloudflare.net/git/default/team-app.git/info/refs?service=git-upload-pack",
      method: "GET",
      redirect: "manual",
      authorization: "Bearer provider-read-secret",
      accept: "application/x-git-upload-pack-advertisement",
    });
    expect(
      fake.calls.find(
        (call) => "url" in call && call.url.endsWith("git-receive-pack"),
      ),
    ).toMatchObject({
      url: "https://account.artifacts.cloudflare.net/git/default/team-app.git/git-receive-pack",
      method: "POST",
      redirect: "manual",
      authorization: "Bearer provider-write-secret",
      contentType: "application/x-git-receive-pack-request",
      accept: "application/x-git-receive-pack-result",
    });
    expect(
      fake.calls.filter(
        (call) => "operation" in call && call.operation === "token",
      ),
    ).toEqual([
      { operation: "token", name: "team-app", scope: "read", ttl: 300 },
      { operation: "token", name: "team-app", scope: "write", ttl: 300 },
    ]);
    expect(
      fake.calls.filter(
        (call) => "operation" in call && call.operation === "revoke",
      ),
    ).toHaveLength(2);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("rejects an Artifacts Git redirect without forwarding the repo token", async () => {
  const fake = fakeNamespace();
  fake.repositories.set("team-app", {
    id: "id-team-app",
    name: "team-app",
    remote: "https://account.artifacts.cloudflare.net/git/default/team-app.git",
    source: null,
  });
  fake.seedRepository("team-app");
  const artifacts = createArtifacts(fake);
  const providerFetch = vi.fn(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/elsewhere" },
      }),
  );
  vi.stubGlobal("fetch", providerFetch);
  try {
    await expect(
      artifacts.exchangeGit({
        repository: "team-app",
        operation: "upload-pack-advertisement",
      }),
    ).rejects.toThrow("Artifacts Git upstream redirected");
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(fake.calls).toContainEqual({
      operation: "revoke",
      name: "team-app",
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it("revokes a Git token when the upstream exchange fails", async () => {
  const fake = fakeNamespace();
  fake.repositories.set("team-app", {
    id: "id-team-app",
    name: "team-app",
    remote: "https://account.artifacts.cloudflare.net/git/default/team-app.git",
    source: null,
  });
  fake.seedRepository("team-app");
  const artifacts = createArtifacts(fake);
  vi.stubGlobal("fetch", () =>
    Promise.reject(new Error("upstream unavailable")),
  );
  try {
    await expect(
      artifacts.exchangeGit({
        repository: "team-app",
        operation: "upload-pack-advertisement",
      }),
    ).rejects.toThrow("upstream unavailable");
    expect(fake.calls).toContainEqual({
      operation: "revoke",
      name: "team-app",
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it("reports Git stream read, cancel, and token cleanup failures together", async () => {
  const fake = fakeNamespace();
  fake.repositories.set("team-app", {
    id: "id-team-app",
    name: "team-app",
    remote: "https://account.artifacts.cloudflare.net/git/default/team-app.git",
    source: null,
  });
  fake.seedRepository("team-app");
  fake.failRevocationOnce();
  const readFailure = new Error("Git stream read failed");
  const cancelFailure = new Error("Git stream cancel failed");
  const upstreamBody = new ReadableStream<Uint8Array>();
  const upstream = new Response(upstreamBody, {
    headers: { "content-type": "application/x-git-upload-pack-result" },
  });
  const body = upstream.body;
  if (body === null) throw new Error("Git fixture body missing");
  const upstreamReader = body.getReader();
  vi.spyOn(upstreamReader, "read").mockRejectedValue(readFailure);
  const cancel = vi
    .spyOn(upstreamReader, "cancel")
    .mockRejectedValue(cancelFailure);
  vi.spyOn(body, "getReader").mockReturnValue(upstreamReader);
  const artifacts = createCloudflareArtifacts({
    namespace: fake.namespace,
    repositories: fake.repositoriesStore,
    gitFetch: vi.fn().mockResolvedValue(upstream),
  });

  const response = await artifacts.exchangeGit({
    repository: "team-app",
    operation: "upload-pack-advertisement",
  });
  const resultReader = response.body?.getReader();
  if (resultReader === undefined) throw new Error("Git response body missing");
  const result = resultReader.read();
  await expect(result).rejects.toMatchObject({
    name: "AggregateError",
    message: "Artifacts Git stream read and cleanup failed",
    cause: readFailure,
    errors: [
      readFailure,
      cancelFailure,
      { message: "temporary revoke failure" },
    ],
  });
  expect(cancel).toHaveBeenCalledWith(readFailure);
  expect(fake.calls).toContainEqual({
    operation: "revoke",
    name: "team-app",
  });
});

it("never adopts an existing repository whose Artifacts fork source differs", async () => {
  await withGitAdvertisement(
    [{ ref: "refs/heads/main", oid: "a".repeat(40) }],
    async () => {
      const fake = fakeNamespace();
      fake.repositories.set("template-app", {
        id: "id-template-app",
        name: "template-app",
        remote:
          "https://account.artifacts.cloudflare.net/git/default/template-app.git",
        source: null,
      });
      fake.seedRepository("template-app");
      fake.repositories.set("team-app", {
        id: "id-team-app",
        name: "team-app",
        remote:
          "https://account.artifacts.cloudflare.net/git/default/team-app.git",
        source: "artifacts:default/another-template",
      });
      fake.seedRepository("team-app", "another-template");
      const artifacts = createArtifacts(fake);
      await expect(
        artifacts.forkRepository({
          template: "template-app",
          repository: "team-app",
          expectedMainHead: "a".repeat(40),
        }),
      ).rejects.toThrow("Artifacts fork destination belongs to another source");
    },
  );
});

it("fails closed for an existing destination without stored fork provenance", async () => {
  await withGitAdvertisement(
    [{ ref: "refs/heads/main", oid: "a".repeat(40) }],
    async () => {
      const fake = fakeNamespace();
      fake.repositories.set("template-app", {
        id: "id-template-app",
        name: "template-app",
        remote:
          "https://account.artifacts.cloudflare.net/git/default/template-app.git",
        source: null,
      });
      fake.seedRepository("template-app");
      fake.repositories.set("team-app", {
        id: "id-team-app",
        name: "team-app",
        remote:
          "https://account.artifacts.cloudflare.net/git/default/team-app.git",
        source: null,
      });
      const artifacts = createArtifacts(fake);
      await expect(
        artifacts.forkRepository({
          template: "template-app",
          repository: "team-app",
          expectedMainHead: "a".repeat(40),
        }),
      ).rejects.toThrow("Artifacts repository creation race was not recorded");
    },
  );
});

it("rejects invalid repository identities before touching the provider", async () => {
  const fake = fakeNamespace();
  const artifacts = createArtifacts(fake);
  await expect(artifacts.resolveRepository("../team-app")).rejects.toThrow(
    "Invalid repository name",
  );
  expect(fake.calls).toEqual([]);
});
