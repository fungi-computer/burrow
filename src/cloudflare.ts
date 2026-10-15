/// <reference types="@cloudflare/workers-types" />

import type {
  Artifacts as ArtifactsApi,
  ArtifactsForkResult,
  ArtifactsRepository,
  GitExchange,
} from "./artifacts.js";
import { listServerRefs } from "isomorphic-git";
import http from "isomorphic-git/http/web";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type { ArtifactsRepositoryInfo } from "./namespace.js";

const artifactsErrorSchema = Schema.Struct({
  code: Schema.Literals([
    "NOT_FOUND",
    "ALREADY_EXISTS",
    "IMPORT_IN_PROGRESS",
    "FORK_IN_PROGRESS",
  ]),
});

/** Repository handle accepted by the Cloudflare Artifacts namespace. */
export type CloudflareArtifactsRepositoryHandle = Readonly<{
  /** REST handles are lazy; info resolves their live existence/readiness. */
  info?: () => Promise<ArtifactsRepositoryInfo>;
  /** Mint a host-only read/write token for the requested lifetime. */
  createToken(
    scope: "read" | "write",
    ttlSeconds: number,
  ): Promise<Readonly<{ id: string; plaintext: string; expiresAt: string }>>;
  /** Revoke this exact credential before releasing a response or activating metadata. */
  revokeToken(tokenOrId: string): Promise<boolean>;
  /** Fork the source main branch and return the destination initial credential. */
  fork(
    name: string,
    options: {
      readOnly: false;
      defaultBranchOnly: true;
    },
  ): Promise<
    Readonly<{
      id: string;
      name: string;
      remote: string;
      defaultBranch: string;
      token: string;
    }>
  >;
}>;

/** Provider identity recorded at creation; used to pin later remote access. */
export type CloudflareArtifactsRepositoryMetadata = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly remote: string;
  readonly parentRepository: string | null;
}>;

/** Host-owned durable metadata and pending initial-token revocation records. */
export type CloudflareArtifactsRepositoryMetadataStore = Readonly<{
  /** Read activated metadata for this repository, or null if none was recorded. */
  read(name: string): Promise<CloudflareArtifactsRepositoryMetadata | null>;
  /** Read the exact staged identity and initial credential awaiting revocation. */
  readPending(name: string): Promise<Readonly<{
    metadata: CloudflareArtifactsRepositoryMetadata;
    initialToken: string;
  }> | null>;
  /** Durably stage provider identity and its initial credential before activation. */
  recordPending(
    metadata: CloudflareArtifactsRepositoryMetadata,
    initialToken: string,
  ): Promise<void>;
  /** Promote the staged identity after revocation and clear the pending credential. */
  activate(
    metadata: CloudflareArtifactsRepositoryMetadata,
    initialToken: string,
  ): Promise<void>;
}>;

/** The maintained Cloudflare namespace methods used by this private adapter. */
export type CloudflareArtifactsNamespace = Readonly<{
  /** Resolve a provider repository handle or throw its typed availability error. */
  get(name: string): Promise<CloudflareArtifactsRepositoryHandle>;
  /** Read provider repository statuses with bounded cursor pagination. */
  list(options?: {
    limit?: number;
    cursor?: string;
  }): Promise<CloudflareArtifactsRepositoryPage>;
  /** Create a repository with the main branch and return its initial credential. */
  create(
    name: string,
    options: { readOnly: false; setDefaultBranch: "main" },
  ): Promise<
    Readonly<{
      id: string;
      name: string;
      remote: string;
      defaultBranch: string;
      token: string;
    }>
  >;
}>;

const REPOSITORY_NAME = /^[a-zA-Z0-9._-]{1,128}$/;
const REMOTE_PATH = /^\/git\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\.git$/;
const RESPONSE_HEADERS = ["cache-control", "content-type", "pragma"] as const;
const REPOSITORY_READY_POLL_INTERVAL_MS = 500;
const REPOSITORY_READY_TIMEOUT_MS = 120_000;
const REPOSITORY_METADATA_RETRY_DELAYS_MS = [
  20, 40, 80, 160, 320, 640, 800,
] as const;

type ArtifactsErrorCode =
  "NOT_FOUND" | "ALREADY_EXISTS" | "IMPORT_IN_PROGRESS" | "FORK_IN_PROGRESS";

const repositoryStatusPageSchema = Schema.Struct({
  repos: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.Literals(["ready", "importing", "forking"]),
    }),
  ),
  total: Schema.Number,
  cursor: Schema.optional(Schema.String),
});
/** Repository listing page used to observe fork/import readiness. */
export type CloudflareArtifactsRepositoryPage = Readonly<{
  repos: readonly Readonly<{ name: string }>[];
  total: number;
  cursor?: string;
}>;

/** A repository did not finish importing or forking within the readiness window. */
export class ArtifactsForkStuckError extends Error {
  override readonly name = "ArtifactsForkStuckError";

  constructor(
    readonly repository: string,
    readonly status: "missing" | "importing" | "forking",
  ) {
    super(
      `Artifacts repository ${repository} did not become ready (${status})`,
    );
  }
}

async function readRepositoryStatus(
  binding: CloudflareArtifactsNamespace,
  name: string,
): Promise<"ready" | "importing" | "forking" | "missing"> {
  let cursor: string | undefined;
  do {
    const options =
      cursor === undefined ? { limit: 200 } : { limit: 200, cursor };
    const raw: unknown = await binding.list(options);
    const page = Schema.decodeUnknownSync(repositoryStatusPageSchema)(raw);
    const repository = page.repos.find((item) => item.name === name);
    if (repository) return repository.status;
    cursor = page.cursor;
  } while (cursor !== undefined);
  return "missing";
}

async function repositoryHandleWhenReady(
  binding: CloudflareArtifactsNamespace,
  name: string,
): Promise<CloudflareArtifactsRepositoryHandle> {
  const deadline = Date.now() + REPOSITORY_READY_TIMEOUT_MS;
  let status: "ready" | "importing" | "forking" | "missing" = "missing";
  while (Date.now() < deadline) {
    status = await readRepositoryStatus(binding, name);
    if (status === "ready" || status === "missing") {
      try {
        const repository = await binding.get(name);
        // Workers get resolves the repository; REST get only addresses it.
        // Metadata promotion requires the latter's live provider check.
        if (repository.info !== undefined) await repository.info();
        return repository;
      } catch (error) {
        const code =
          error instanceof Error ? artifactsErrorCode(error) : undefined;
        // Namespace listing and handle availability can disagree during a fork.
        // Only the provider's documented readiness refusals extend this wait;
        // NOT_FOUND still allows ordinary repository discovery to create it.
        if (code === "FORK_IN_PROGRESS") status = "forking";
        else if (code === "IMPORT_IN_PROGRESS") status = "importing";
        else throw error;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) =>
      setTimeout(
        resolve,
        Math.min(REPOSITORY_READY_POLL_INTERVAL_MS, remaining),
      ),
    );
  }
  throw new ArtifactsForkStuckError(name, status);
}

function repositoryName(name: string): string {
  if (!REPOSITORY_NAME.test(name))
    throw new TypeError("Invalid repository name");
  return name;
}

function repositoryMetadata(
  repository: {
    id: string;
    name: string;
    defaultBranch: string;
    remote: string;
  },
  parentRepository: string | null,
): CloudflareArtifactsRepositoryMetadata {
  if (
    repository.id.length === 0 ||
    !REPOSITORY_NAME.test(repository.name) ||
    repository.defaultBranch !== "main"
  )
    throw new Error("Artifacts repository identity is invalid");
  artifactsRemote(repository.remote, repository.name);
  if (parentRepository !== null) {
    repositoryName(parentRepository);
    if (parentRepository === repository.name)
      throw new Error("Artifacts repository parent identity is invalid");
  }
  return Object.freeze({
    id: repository.id,
    name: repository.name,
    defaultBranch: repository.defaultBranch,
    remote: repository.remote,
    parentRepository,
  });
}

function repositoryIdentity(
  repository: CloudflareArtifactsRepositoryMetadata,
): ArtifactsRepository {
  return Object.freeze({
    id: repository.id,
    name: repository.name,
    defaultBranch: repository.defaultBranch,
  });
}

function artifactsErrorCode(error: Error): ArtifactsErrorCode | undefined {
  const decoded = Schema.decodeUnknownExit(artifactsErrorSchema)(error);
  return Exit.isSuccess(decoded) ? decoded.value.code : undefined;
}

async function withRevokedInitialToken<A>(options: {
  lookup(): Promise<CloudflareArtifactsRepositoryHandle>;
  token: string;
  use(repository: CloudflareArtifactsRepositoryHandle): Promise<A>;
}): Promise<A> {
  let repository: CloudflareArtifactsRepositoryHandle | undefined;
  const operation = Promise.resolve().then(async () => {
    repository = await options.lookup();
    return options.use(repository);
  });
  const outcome = await operation.then(
    (value) => ({ kind: "succeeded" as const, value }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  const revocation = await Promise.resolve()
    .then(async () => {
      // A transient read-back failure must not skip revocation. Retry the lookup
      // in the cleanup path so a token returned by create/fork is still revoked.
      const owner = repository ?? (await options.lookup());
      if (!(await owner.revokeToken(options.token)))
        throw new Error("Artifacts initial token could not be revoked");
    })
    .then(
      () => ({ kind: "revoked" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
  if (outcome.kind === "failed") {
    if (revocation.kind === "failed")
      throw new AggregateError(
        [outcome.error, revocation.error],
        "Artifacts operation failed and token cleanup failed",
      );
    if (outcome.error instanceof Error) throw outcome.error;
    throw new Error("Artifacts operation failed", { cause: outcome.error });
  }
  if (revocation.kind === "failed") {
    if (revocation.error instanceof Error) throw revocation.error;
    throw new Error("Artifacts token cleanup failed", {
      cause: revocation.error,
    });
  }
  return outcome.value;
}

async function recordPendingWithRetry(
  repositories: CloudflareArtifactsRepositoryMetadataStore,
  metadata: CloudflareArtifactsRepositoryMetadata,
  initialToken: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await repositories.recordPending(metadata, initialToken);
      return;
    } catch (error) {
      const delayMs = REPOSITORY_METADATA_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function finishPendingRepository(
  binding: CloudflareArtifactsNamespace,
  repositories: CloudflareArtifactsRepositoryMetadataStore,
  name: string,
): Promise<CloudflareArtifactsRepositoryMetadata | null> {
  const pending = await repositories.readPending(name);
  if (pending === null) return null;
  const metadata = parseStoredMetadata(pending.metadata, name);
  const repository = await repositoryHandleWhenReady(binding, name);
  try {
    // Maintained Workers types define false as "not found". Replay uses the
    // persisted plaintext, so this concerns this exact token; unrelated repo
    // tokens do not affect promotion.
    await repository.revokeToken(pending.initialToken);
  } catch {
    // The provider error may echo its argument; never attach this plaintext
    // token-bearing failure as a cause that a caller might log.
    throw new Error("Artifacts initial token cleanup could not be confirmed");
  }
  await repositories.activate(metadata, pending.initialToken);
  return metadata;
}

async function readDefaultBranchHead(
  binding: CloudflareArtifactsNamespace,
  repositories: CloudflareArtifactsRepositoryMetadataStore,
  name: string,
  gitHttp: typeof http = http,
): Promise<string | null> {
  const safeName = repositoryName(name);
  const metadata = await requireRepositoryMetadata(
    binding,
    repositories,
    safeName,
  );
  const repository = await repositoryHandleWhenReady(binding, safeName);
  const remote = artifactsRemote(metadata.remote, metadata.name).url;
  const token = await repository.createToken("read", 60);
  return withRevokedInitialToken({
    lookup: () => Promise.resolve(repository),
    token: token.id,
    use: async () => {
      const refs = await listServerRefs({
        http: gitHttp,
        url: remote.toString(),
        headers: { Authorization: `Bearer ${token.plaintext}` },
        prefix: "refs/heads/main",
      });
      const mainRefs = refs.filter((ref) => ref.ref === "refs/heads/main");
      if (mainRefs.length === 0) return null;
      const [main] = mainRefs;
      if (mainRefs.length !== 1 || !main || !/^[0-9a-f]{40}$/u.test(main.oid))
        throw new Error("Artifacts main ref is ambiguous or invalid");
      return main.oid;
    },
  });
}

async function readRefs(
  binding: CloudflareArtifactsNamespace,
  repositories: CloudflareArtifactsRepositoryMetadataStore,
  name: string,
  gitHttp: typeof http = http,
): Promise<readonly Readonly<{ name: string; hash: string }>[]> {
  const safeName = repositoryName(name);
  const metadata = await requireRepositoryMetadata(
    binding,
    repositories,
    safeName,
  );
  const repository = await repositoryHandleWhenReady(binding, safeName);
  const remote = artifactsRemote(metadata.remote, metadata.name).url;
  const token = await repository.createToken("read", 60);
  return withRevokedInitialToken({
    lookup: () => Promise.resolve(repository),
    token: token.id,
    use: async () => {
      const refs = await listServerRefs({
        http: gitHttp,
        url: remote.toString(),
        headers: { Authorization: `Bearer ${token.plaintext}` },
      });
      return Object.freeze(
        refs.map(({ ref, oid }) => ({ name: ref, hash: oid })),
      );
    },
  });
}

function artifactsRemote(remote: string, repository: string) {
  let target: URL;
  try {
    target = new URL(remote);
  } catch {
    throw new TypeError("Artifacts returned an invalid Git remote");
  }
  const suffix = ".artifacts.cloudflare.net";
  const account = target.hostname.toLowerCase().endsWith(suffix)
    ? target.hostname.slice(0, -suffix.length)
    : "";
  const match = REMOTE_PATH.exec(target.pathname);
  if (
    target.protocol !== "https:" ||
    account.length === 0 ||
    account.includes(".") ||
    target.port.length > 0 ||
    target.username.length > 0 ||
    target.password.length > 0 ||
    target.search.length > 0 ||
    target.hash.length > 0 ||
    !match?.[1] ||
    match[2] !== repository
  )
    throw new TypeError("Artifacts returned an invalid Git remote");
  return { url: target, namespace: match[1] };
}

function parseStoredMetadata(
  metadata: CloudflareArtifactsRepositoryMetadata,
  expectedName: string,
): CloudflareArtifactsRepositoryMetadata {
  const parsed = repositoryMetadata(metadata, metadata.parentRepository);
  if (parsed.name !== expectedName)
    throw new Error("Artifacts repository metadata identity conflicts");
  return parsed;
}

function sameRepositoryMetadata(
  left: CloudflareArtifactsRepositoryMetadata,
  right: CloudflareArtifactsRepositoryMetadata,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.defaultBranch === right.defaultBranch &&
    left.remote === right.remote &&
    left.parentRepository === right.parentRepository
  );
}

async function finishOrReadCreatedRepository(
  binding: CloudflareArtifactsNamespace,
  repositories: CloudflareArtifactsRepositoryMetadataStore,
  expected: CloudflareArtifactsRepositoryMetadata,
): Promise<CloudflareArtifactsRepositoryMetadata> {
  const finished = await finishPendingRepository(
    binding,
    repositories,
    expected.name,
  );
  const saved = finished ?? (await repositories.read(expected.name));
  if (saved === null)
    throw new Error("Artifacts repository creation was not recorded");
  const verified = parseStoredMetadata(saved, expected.name);
  if (!sameRepositoryMetadata(verified, expected))
    throw new Error("Artifacts repository creation metadata conflicts");
  await repositoryHandleWhenReady(binding, expected.name);
  return verified;
}

async function knownRepositoryMetadata(
  binding: CloudflareArtifactsNamespace,
  repositories: CloudflareArtifactsRepositoryMetadataStore,
  name: string,
): Promise<CloudflareArtifactsRepositoryMetadata | null> {
  await finishPendingRepository(binding, repositories, name);
  const stored = await repositories.read(name);
  return stored === null ? null : parseStoredMetadata(stored, name);
}

async function existingRepositoryMetadata(
  binding: CloudflareArtifactsNamespace,
  repositories: CloudflareArtifactsRepositoryMetadataStore,
  name: string,
): Promise<CloudflareArtifactsRepositoryMetadata | null> {
  const stored = await knownRepositoryMetadata(binding, repositories, name);
  if (stored !== null) {
    await repositoryHandleWhenReady(binding, name);
    return stored;
  }
  try {
    await repositoryHandleWhenReady(binding, name);
  } catch (error) {
    if (error instanceof Error && artifactsErrorCode(error) === "NOT_FOUND")
      return null;
    throw error;
  }
  return waitForRecordedRepositoryMetadata(binding, repositories, name);
}

async function requireRepositoryMetadata(
  binding: CloudflareArtifactsNamespace,
  repositories: CloudflareArtifactsRepositoryMetadataStore,
  name: string,
): Promise<CloudflareArtifactsRepositoryMetadata> {
  const known = await knownRepositoryMetadata(binding, repositories, name);
  if (known !== null) return known;
  try {
    await repositoryHandleWhenReady(binding, name);
  } catch (error) {
    if (error instanceof Error && artifactsErrorCode(error) === "NOT_FOUND")
      throw new Error("Artifacts repository metadata is unavailable", {
        cause: error,
      });
    throw error;
  }
  return waitForRecordedRepositoryMetadata(binding, repositories, name);
}

async function waitForRecordedRepositoryMetadata(
  binding: CloudflareArtifactsNamespace,
  repositories: CloudflareArtifactsRepositoryMetadataStore,
  name: string,
): Promise<CloudflareArtifactsRepositoryMetadata> {
  for (const delayMs of REPOSITORY_METADATA_RETRY_DELAYS_MS) {
    const metadata = await knownRepositoryMetadata(binding, repositories, name);
    if (metadata !== null) return metadata;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
  const metadata = await knownRepositoryMetadata(binding, repositories, name);
  if (metadata !== null) return metadata;
  throw new Error("Artifacts repository creation race was not recorded");
}

function gitTarget(
  remote: string,
  repository: string,
  operation: GitExchange["operation"],
): URL {
  const { url: target } = artifactsRemote(remote, repository);

  const service = operation.startsWith("upload-pack")
    ? "git-upload-pack"
    : "git-receive-pack";
  if (operation.endsWith("advertisement")) {
    target.pathname += "/info/refs";
    target.searchParams.set("service", service);
  } else {
    target.pathname += `/${service}`;
  }
  return target;
}

function requestMethod(operation: GitExchange["operation"]): "GET" | "POST" {
  return operation.endsWith("advertisement") ? "GET" : "POST";
}

function gitContentType(
  operation: GitExchange["operation"],
): string | undefined {
  if (operation === "upload-pack-advertisement")
    return "application/x-git-upload-pack-advertisement";
  if (operation === "receive-pack-advertisement")
    return "application/x-git-receive-pack-advertisement";
  if (operation === "upload-pack")
    return "application/x-git-upload-pack-request";
  return "application/x-git-receive-pack-request";
}

function gitAcceptType(operation: GitExchange["operation"]): string {
  if (operation === "upload-pack-advertisement")
    return "application/x-git-upload-pack-advertisement";
  if (operation === "receive-pack-advertisement")
    return "application/x-git-receive-pack-advertisement";
  if (operation === "upload-pack")
    return "application/x-git-upload-pack-result";
  return "application/x-git-receive-pack-result";
}

function readScope(operation: GitExchange["operation"]): "read" | "write" {
  return operation.startsWith("upload-pack") ? "read" : "write";
}

/** Execute Git with an already-held repo credential. The custody owner chooses
 * metadata and credential; caller URLs and authorization headers never enter. */
export async function exchangeCloudflareArtifactsGit(
  metadata: CloudflareArtifactsRepositoryMetadata,
  input: GitExchange,
  credential: string,
  gitFetch: typeof fetch,
): Promise<Response> {
  const name = repositoryName(input.repository);
  if (metadata.name !== name) throw new Error("Artifacts repository mismatch");
  const remote = gitTarget(metadata.remote, name, input.operation);
  const method = requestMethod(input.operation);
  const headers = new Headers({
    authorization: `Bearer ${credential}`,
    accept: gitAcceptType(input.operation),
  });
  if (method === "POST")
    headers.set(
      "content-type",
      gitContentType(input.operation) ?? "application/octet-stream",
    );
  if (input.protocol !== undefined) headers.set("Git-Protocol", input.protocol);
  const request: RequestInit = {
    method,
    headers,
    redirect: "manual",
    signal: input.signal ?? null,
  };
  if ("body" in input) request.body = input.body;
  const upstream = await gitFetch(remote, request);
  if (upstream.status >= 300 && upstream.status < 400)
    throw new Error("Artifacts Git upstream redirected");
  return upstream;
}

async function exchange(
  binding: CloudflareArtifactsNamespace,
  repositories: CloudflareArtifactsRepositoryMetadataStore,
  input: GitExchange,
  gitFetch: typeof fetch = (input, init) => fetch(input, init),
): Promise<Response> {
  const name = repositoryName(input.repository);
  const metadata = await requireRepositoryMetadata(binding, repositories, name);
  const repository = await repositoryHandleWhenReady(binding, name);
  // Preserve the existing refusal before minting if registered metadata is invalid.
  artifactsRemote(metadata.remote, name);
  const token = await repository.createToken(readScope(input.operation), 300);
  let revokePromise: Promise<void> | undefined;
  const revoke = () => {
    revokePromise ??= repository.revokeToken(token.id).then((revoked) => {
      if (!revoked) throw new Error("Artifacts Git token could not be revoked");
    });
    return revokePromise;
  };
  try {
    const upstream = await exchangeCloudflareArtifactsGit(
      metadata,
      input,
      token.plaintext,
      gitFetch,
    );
    const responseHeaders = new Headers();
    for (const header of RESPONSE_HEADERS) {
      const value = upstream.headers.get(header);
      if (value !== null) responseHeaders.set(header, value);
    }
    if (upstream.body === null) {
      await revoke();
      return new Response(null, {
        status: upstream.status,
        headers: responseHeaders,
      });
    }
    const upstreamBody: ReadableStream<Uint8Array> = upstream.body;
    const reader = upstreamBody.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            controller.close();
            await revoke();
          } else {
            controller.enqueue(result.value);
          }
        } catch (error) {
          const cancellation = await reader.cancel(error).then(
            () => ({ kind: "cancelled" as const }),
            (cancelError: unknown) =>
              cancelError === error
                ? { kind: "same-error" as const }
                : { kind: "failed" as const, error: cancelError },
          );
          const revocation = await revoke().then(
            () => ({ kind: "revoked" as const }),
            (revokeError: unknown) => ({
              kind: "failed" as const,
              error: revokeError,
            }),
          );
          const cleanupFailures = [
            ...(cancellation.kind === "failed" ? [cancellation.error] : []),
            ...(revocation.kind === "failed" ? [revocation.error] : []),
          ];
          controller.error(
            cleanupFailures.length === 0
              ? error
              : new AggregateError(
                  [error, ...cleanupFailures],
                  "Artifacts Git stream read and cleanup failed",
                  { cause: error },
                ),
          );
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          await revoke();
        }
      },
    });
    return new Response(body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    await revoke();
    throw error;
  }
}

/** Provider, durable metadata store and optional Git protocol transports. */
export type CloudflareArtifactsOptions = Readonly<{
  namespace: CloudflareArtifactsNamespace;
  repositories: CloudflareArtifactsRepositoryMetadataStore;
  /** Optional transport for Git protocol traffic; control remains on the namespace. */
  gitHttp?: typeof http;
  gitFetch?: typeof fetch;
}>;

/** Configure the Artifacts owner once; provider remotes and credentials stay private. */
export function createCloudflareArtifacts(
  options: CloudflareArtifactsOptions,
): ArtifactsApi {
  const binding = options.namespace;
  const repositories = options.repositories;
  const gitHttp = options.gitHttp ?? http;
  const gitFetch: typeof fetch =
    options.gitFetch ?? ((input, init) => fetch(input, init));
  const recoverForkRepository = async (input: {
    template: string;
    repository: string;
  }): Promise<ArtifactsForkResult | null> => {
    const template = repositoryName(input.template);
    const destination = repositoryName(input.repository);
    const existing = await existingRepositoryMetadata(
      binding,
      repositories,
      destination,
    );
    if (existing === null) return null;
    if (existing.parentRepository !== template)
      throw new Error("Artifacts fork destination belongs to another source");
    const mainHead = await readDefaultBranchHead(
      binding,
      repositories,
      destination,
    );
    if (mainHead === null)
      throw new Error("Artifacts fork destination has no main commit");
    return {
      repository: repositoryIdentity(existing),
      mainHead,
      disposition: "existing",
    };
  };
  return Object.freeze({
    ensureRepository: async (name: string): Promise<ArtifactsRepository> => {
      const safeName = repositoryName(name);
      const existing = await existingRepositoryMetadata(
        binding,
        repositories,
        safeName,
      );
      if (existing !== null) return repositoryIdentity(existing);
      let created: Awaited<ReturnType<CloudflareArtifactsNamespace["create"]>>;
      try {
        created = await binding.create(safeName, {
          readOnly: false,
          setDefaultBranch: "main",
        });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (artifactsErrorCode(error) !== "ALREADY_EXISTS") throw error;
        const raced = await waitForRecordedRepositoryMetadata(
          binding,
          repositories,
          safeName,
        );
        return repositoryIdentity(raced);
      }
      const metadata = repositoryMetadata(created, null);
      if (metadata.name !== safeName)
        throw new Error("Artifacts create returned another repository");
      await recordPendingWithRetry(repositories, metadata, created.token);
      const activated = await finishOrReadCreatedRepository(
        binding,
        repositories,
        metadata,
      );
      return repositoryIdentity(activated);
    },
    forkRepository: async (input): Promise<ArtifactsForkResult> => {
      const recovered = await recoverForkRepository(input);
      if (recovered !== null) return recovered;
      const templateName = repositoryName(input.template);
      const destination = repositoryName(input.repository);
      const templateHead = await readDefaultBranchHead(
        binding,
        repositories,
        templateName,
      );
      if (templateHead === null || templateHead !== input.expectedMainHead)
        throw new Error("Artifacts template main changed before fork");
      const template = await repositoryHandleWhenReady(binding, templateName);
      let forked:
        | Awaited<ReturnType<CloudflareArtifactsRepositoryHandle["fork"]>>
        | undefined;
      try {
        forked = await template.fork(destination, {
          readOnly: false,
          defaultBranchOnly: true,
        });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          artifactsErrorCode(error) !== "ALREADY_EXISTS"
        )
          throw error;
        const stored = await waitForRecordedRepositoryMetadata(
          binding,
          repositories,
          destination,
        );
        if (stored.parentRepository !== templateName)
          throw new Error(
            "Artifacts fork destination belongs to another source",
            { cause: error },
          );
        const mainHead = await readDefaultBranchHead(
          binding,
          repositories,
          destination,
        );
        if (mainHead === null)
          throw new Error("Artifacts fork destination has no main commit", {
            cause: error,
          });
        const recovered: ArtifactsForkResult = {
          repository: repositoryIdentity(stored),
          mainHead,
          disposition: "existing",
        };
        return recovered;
      }
      const metadata = repositoryMetadata(forked, templateName);
      if (metadata.name !== destination)
        throw new Error("Artifacts fork returned another repository");
      await recordPendingWithRetry(repositories, metadata, forked.token);
      const activated = await finishOrReadCreatedRepository(
        binding,
        repositories,
        metadata,
      );
      const mainHead = await readDefaultBranchHead(
        binding,
        repositories,
        destination,
      );
      if (mainHead === null || mainHead !== templateHead)
        throw new Error("Artifacts fork main does not match template main");
      return {
        repository: repositoryIdentity(activated),
        mainHead,
        disposition: "created",
      };
    },
    recoverForkRepository,
    resolveRepository: async (name): Promise<ArtifactsRepository> => {
      const safeName = repositoryName(name);
      const metadata = await requireRepositoryMetadata(
        binding,
        repositories,
        safeName,
      );
      await repositoryHandleWhenReady(binding, safeName);
      return repositoryIdentity(metadata);
    },
    readDefaultBranchHead: (name): Promise<string | null> =>
      readDefaultBranchHead(binding, repositories, name, gitHttp),
    readBranchHeads: (name): Promise<readonly string[]> =>
      readRefs(binding, repositories, name, gitHttp).then((refs) =>
        refs
          .filter((ref) => ref.name.startsWith("refs/heads/"))
          .map((ref) => ref.hash),
      ),
    readRefs: (name) => readRefs(binding, repositories, name, gitHttp),
    exchangeGit: (input) => exchange(binding, repositories, input, gitFetch),
  });
}
