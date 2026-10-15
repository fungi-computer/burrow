import * as Schema from "effect/Schema";
import type {
  ArtifactsNamespace,
  ArtifactsCommit,
  ArtifactsTreeEntry,
} from "./namespace.js";

/** Where the REST API is and how to reach it. */
export type ArtifactsRestOptions = Readonly<{
  accountId: string;
  namespace: string;
  /** A Cloudflare API token with Artifacts read and write. */
  apiToken: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}>;

const repoSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  default_branch: Schema.String,
  remote: Schema.String,
  last_push_at: Schema.optional(Schema.NullOr(Schema.String)),
  source: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.String),
});
const envelopeSchema = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.Unknown,
  errors: Schema.Array(
    Schema.Struct({ code: Schema.Number, message: Schema.String }),
  ),
  result_info: Schema.optional(
    Schema.Struct({
      cursor: Schema.optional(Schema.NullOr(Schema.String)),
      total_pages: Schema.optional(Schema.Number),
      total_count: Schema.optional(Schema.Number),
    }),
  ),
});
const tokenSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  plaintext: Schema.NonEmptyString,
  expires_at: Schema.NonEmptyString,
});
const createdSchema = Schema.Struct({
  ...repoSchema.fields,
  token: Schema.NonEmptyString,
});
const listedTokensSchema = Schema.Array(
  Schema.Struct({
    id: Schema.NonEmptyString,
    state: Schema.Literals(["active", "expired", "revoked"]),
  }),
);

/** The string codes the binding throws, from the REST API's numeric codes. */
const errorCodes = new Map([
  [10200, "NOT_FOUND"],
  [10201, "ALREADY_EXISTS"],
  [10302, "IMPORT_IN_PROGRESS"],
  [10303, "FORK_IN_PROGRESS"],
]);

/** A failed Artifacts REST call, with the binding's error `code`. */
export class ArtifactsRestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function decode<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  raw: unknown,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema)(raw);
  } catch {
    throw new ArtifactsRestError(
      "INVALID_RESPONSE",
      "Artifacts returned an invalid response",
    );
  }
}

function toInfo(repo: typeof repoSchema.Type) {
  return {
    id: repo.id,
    name: repo.name,
    defaultBranch: repo.default_branch,
    remote: repo.remote,
    lastPushAt: repo.last_push_at ?? null,
    source: repo.source ?? null,
  };
}

/** An Artifacts namespace reached over REST, with the binding's shape. */
export function createArtifactsRestNamespace(
  options: ArtifactsRestOptions,
): ArtifactsNamespace {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/artifacts/namespaces/${encodeURIComponent(options.namespace)}`;
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${options.apiToken}`);
    if (init.body !== undefined)
      headers.set("Content-Type", "application/json");
    return send(`${base}${path}`, { ...init, headers, redirect: "manual" });
  };
  const json = async (path: string, init: RequestInit = {}) => {
    const response = await request(path, init);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ArtifactsRestError(
        "REDIRECT_REFUSED",
        "Artifacts redirect refused",
      );
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new ArtifactsRestError(
        "INVALID_RESPONSE",
        "Artifacts returned an invalid response",
      );
    }
    const body = decode(envelopeSchema, raw);
    if (!response.ok || !body.success) {
      const [first] = body.errors;
      throw new ArtifactsRestError(
        (first && errorCodes.get(first.code)) ?? "INTERNAL_ERROR",
        `Artifacts request failed (${String(response.status)})`,
      );
    }
    return body;
  };
  const bytes = async (path: string): Promise<Uint8Array | null> => {
    const response = await request(path);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok)
      throw new ArtifactsRestError(
        "INTERNAL_ERROR",
        `Artifacts read failed (${String(response.status)})`,
      );
    return new Uint8Array(await response.arrayBuffer());
  };
  const orNull = async <T>(read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (error) {
      if (error instanceof ArtifactsRestError && error.code === "NOT_FOUND")
        return null;
      throw error;
    }
  };
  const repoPath = (name: string) => `/repos/${encodeURIComponent(name)}`;
  const revokedInitialTokenIds = new Set<string>();
  const mintedTokenIds = new Map<string, string>();
  const readInitialTokens = async (path: string) => {
    const page = await json(path);
    const tokens = decode(listedTokensSchema, page.result);
    if (
      page.result_info?.total_pages !== 1 ||
      page.result_info.total_count !== tokens.length ||
      tokens.length > 100
    )
      throw new Error("Artifacts initial token page is incomplete");
    return tokens;
  };
  const finishCreated = async (name: string, raw: unknown) => {
    try {
      const created = Schema.decodeUnknownSync(createdSchema)(raw);
      if (created.name !== name)
        throw new Error("Artifacts repository identity conflicts");
      const tokenPath = `${repoPath(name)}/tokens?state=all&per_page=100&page=1`;
      const listed = await readInitialTokens(tokenPath);
      const active = listed.filter((token) => token.state === "active");
      const [initial] = active;
      if (active.length !== 1 || !initial)
        throw new Error("Artifacts initial token is ambiguous");
      await json(`/tokens/${encodeURIComponent(initial.id)}`, {
        method: "DELETE",
      });
      const verified = await readInitialTokens(tokenPath);
      if (
        verified.filter(
          (token) => token.id === initial.id && token.state === "revoked",
        ).length !== 1 ||
        verified.some((token) => token.state === "active")
      )
        throw new Error("Artifacts initial token revocation was not verified");
      revokedInitialTokenIds.add(initial.id);
      return { ...toInfo(created), token: initial.id };
    } catch {
      // Only a successful create/fork reply reaches this cleanup. Existing
      // repositories and the fork's source are never deleted by this path.
      await json(repoPath(name), { method: "DELETE" });
      throw new ArtifactsRestError(
        "INITIAL_TOKEN_REFUSED",
        "Artifacts initial token cleanup refused repository activation",
      );
    }
  };
  return {
    async create(name, opts) {
      const created = await json("/repos", {
        method: "POST",
        body: JSON.stringify({
          name,
          description: opts.description,
          default_branch: opts.setDefaultBranch,
          read_only: false,
        }),
      });
      return finishCreated(name, created.result);
    },
    async list(opts = {}) {
      const query = new URLSearchParams({ limit: String(opts.limit ?? 200) });
      if (opts.cursor !== undefined) query.set("cursor", opts.cursor);
      const page = await json(`/repos?${query.toString()}`);
      const repos = decode(Schema.Array(repoSchema), page.result).map(
        (repo) => ({
          name: repo.name,
          status: repo.status ?? "ready",
        }),
      );
      const cursor = page.result_info?.cursor ?? undefined;
      return cursor === undefined
        ? { repos, total: repos.length }
        : { repos, total: repos.length, cursor };
    },
    async delete(name) {
      return (
        (await orNull(() => json(repoPath(name), { method: "DELETE" }))) !==
        null
      );
    },
    async get(name) {
      const path = repoPath(name);
      return Promise.resolve({
        async info() {
          return toInfo(decode(repoSchema, (await json(path)).result));
        },
        async createToken(scope, ttl) {
          const created = await json("/tokens", {
            method: "POST",
            body: JSON.stringify({ repo: name, scope, ttl }),
          });
          const token = decode(tokenSchema, created.result);
          mintedTokenIds.set(token.plaintext, token.id);
          return {
            id: token.id,
            plaintext: token.plaintext,
            expiresAt: token.expires_at,
          };
        },
        async revokeToken(tokenOrId) {
          if (revokedInitialTokenIds.delete(tokenOrId)) return false;
          const id = mintedTokenIds.get(tokenOrId) ?? tokenOrId;
          const revoked = await orNull(() =>
            json(`/tokens/${encodeURIComponent(id)}`, { method: "DELETE" }),
          );
          for (const [plaintext, tokenId] of mintedTokenIds)
            if (tokenId === id) mintedTokenIds.delete(plaintext);
          return revoked !== null;
        },
        async fork(target, opts) {
          const forked = await json(`${path}/fork`, {
            method: "POST",
            body: JSON.stringify({
              name: target,
              description: opts.description,
              read_only: false,
              default_branch_only: opts.defaultBranchOnly,
            }),
          });
          return finishCreated(target, forked.result);
        },
        async log(opts) {
          const query = new URLSearchParams({
            ref: opts.ref,
            limit: String(opts.limit),
            offset: String(opts.offset),
          });
          const page = await orNull(() =>
            json(`${path}/log?${query.toString()}`),
          );
          // The binding answers an unknown ref with no history.
          return page === null
            ? []
            : decodeCommits(decode(Schema.Array(commitSchema), page.result));
        },
        async readCommit(hash) {
          const page = await orNull(() =>
            json(`${path}/commit/${encodeURIComponent(hash)}`),
          );
          return page === null
            ? null
            : (decodeCommits(
                decode(Schema.Array(commitSchema), [page.result]),
              )[0] ?? null);
        },
        async readTree(hash) {
          const page = await orNull(() =>
            json(`${path}/tree/${encodeURIComponent(hash)}`),
          );
          return page === null
            ? null
            : decodeTree(decode(Schema.Array(treeSchema), page.result));
        },
        async readBlob(hash) {
          const content = await bytes(
            `${path}/blob/${encodeURIComponent(hash)}`,
          );
          return content === null ? null : new Blob([new Uint8Array(content)]);
        },
      });
    },
  };
}

const commitSchema = Schema.Struct({
  hash: Schema.String,
  treeHash: Schema.String,
  message: Schema.String,
  author: Schema.Struct({ name: Schema.String, email: Schema.String }),
  committer: Schema.Struct({ name: Schema.String, email: Schema.String }),
  parents: Schema.Array(Schema.String),
  authoredAt: Schema.Number,
  committedAt: Schema.Number,
});
const treeSchema = Schema.Struct({
  name: Schema.String,
  mode: Schema.String,
  hash: Schema.String,
  type: Schema.Literals(["blob", "tree", "commit"]),
});

function decodeCommits(
  commits: readonly (typeof commitSchema.Type)[],
): ArtifactsCommit[] {
  return commits.map((commit) => ({
    ...commit,
    author: { ...commit.author },
    committer: { ...commit.committer },
    parents: [...commit.parents],
  }));
}

function decodeTree(
  entries: readonly (typeof treeSchema.Type)[],
): ArtifactsTreeEntry[] {
  return [...entries];
}
