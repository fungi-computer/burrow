/** Host-only Artifacts namespace. Repository credentials never enter App results. */
export type ArtifactsRepositoryInfo = Readonly<{
  id: string;
  name: string;
  defaultBranch: string;
  remote: string;
  lastPushAt?: string | null;
  source?: string | null;
}>;
/** Initial revocation reference: a Workers token or an already-revoked REST ID. */
export type ArtifactsCreatedRepository = ArtifactsRepositoryInfo &
  Readonly<{ token: string }>;
/** Provider commit metadata and parent object IDs. */
export type ArtifactsCommit = Readonly<{
  hash: string;
  treeHash: string;
  message: string;
  author: Readonly<{ name: string; email: string }>;
  committer: Readonly<{ name: string; email: string }>;
  parents: readonly string[];
  authoredAt: number;
  committedAt: number;
}>;
/** One provider tree entry, including its mode and object kind. */
export type ArtifactsTreeEntry = Readonly<{
  name: string;
  mode: string;
  hash: string;
  type: "blob" | "tree" | "commit";
}>;
/** Host-only repository operations; secrets never belong in App results. */
export type ArtifactsRepositoryHandle = Readonly<{
  /** Read current provider repository metadata. */
  info(): Promise<ArtifactsRepositoryInfo>;
  /** Mint a read or write credential for the requested lifetime; keep it host-only. */
  createToken(
    scope: "read" | "write",
    ttl: number,
  ): Promise<Readonly<{ id: string; plaintext: string; expiresAt: string }>>;
  /** Revoke this exact token or token ID; false means it is no longer present. */
  revokeToken(tokenOrId: string): Promise<boolean>;
  /** Fork this repository and return the new destination with its revocation reference. */
  fork(
    name: string,
    options: {
      description?: string;
      readOnly: false;
      defaultBranchOnly: boolean;
    },
  ): Promise<ArtifactsCreatedRepository>;
  /** Read a bounded page of commits at the requested ref. */
  log(options: {
    ref: string;
    limit: number;
    offset: number;
  }): Promise<readonly ArtifactsCommit[]>;
  /** Read one commit object, or null if that object is absent. */
  readCommit(hash: string): Promise<ArtifactsCommit | null>;
  /** Read one tree object, or null if that object is absent. */
  readTree(hash: string): Promise<readonly ArtifactsTreeEntry[] | null>;
  /** Read one blob object, or null if that object is absent. */
  readBlob(hash: string): Promise<Blob | null>;
}>;
/** Configured provider namespace with repository-name-addressed handles. */
export type ArtifactsNamespace = Readonly<{
  /** Create a repository; its initial credential must be revoked before activation. */
  create(
    name: string,
    options: {
      description?: string;
      readOnly: false;
      setDefaultBranch: string;
    },
  ): Promise<ArtifactsCreatedRepository>;
  /** Address a repository handle; its operations establish live provider availability. */
  get(name: string): Promise<ArtifactsRepositoryHandle>;
  /** Read a bounded repository-status page and its optional next cursor. */
  list(options?: { limit?: number; cursor?: string }): Promise<
    Readonly<{
      repos: readonly Readonly<{ name: string; status: string }>[];
      total: number;
      cursor?: string;
    }>
  >;
  /** Delete the named repository; return false when it is already absent. */
  delete(name: string): Promise<boolean>;
}>;
