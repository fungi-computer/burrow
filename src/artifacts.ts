/** Stable repository identity exposed to callers; no credentials or remote URL. */
export type ArtifactsRepository = Readonly<{
  id: string;
  name: string;
  defaultBranch: string;
}>;

/** One admitted Git smart-HTTP advertisement or byte-stream exchange. */
export type GitExchange = Readonly<{
  protocol?: string;
  signal?: AbortSignal;
}> &
  (
    | Readonly<{
        repository: string;
        operation: "upload-pack-advertisement" | "receive-pack-advertisement";
      }>
    | Readonly<{
        repository: string;
        operation: "upload-pack" | "receive-pack";
        body: ReadableStream<Uint8Array>;
      }>
  );

/** Recorded fork identity, template main head and whether this call created it. */
export type ArtifactsForkResult = Readonly<{
  repository: ArtifactsRepository;
  mainHead: string;
  disposition: "created" | "existing";
}>;

/** Configured repository owner; authorization belongs to its calling host. */
export type Artifacts = Readonly<{
  /** Create or recover a recorded repository and finish initial-token revocation. */
  ensureRepository(name: string): Promise<ArtifactsRepository>;
  /** Fork the exact reviewed template main head and record its provenance. */
  forkRepository(input: {
    template: string;
    repository: string;
    expectedMainHead: string;
  }): Promise<ArtifactsForkResult>;
  /** Recover only a destination recorded for this exact template, or return null. */
  recoverForkRepository(input: {
    template: string;
    repository: string;
  }): Promise<ArtifactsForkResult | null>;
  /** Resolve recorded repository identity after live existence/readiness checks. */
  resolveRepository(name: string): Promise<ArtifactsRepository>;
  /** Read the current main ref with a short-lived token revoked afterward. */
  readDefaultBranchHead(name: string): Promise<string | null>;
  /** Return advertised branch heads for revision provenance checks. */
  readBranchHeads(name: string): Promise<readonly string[]>;
  /** Return advertised ref names and object IDs under one short-lived read token. */
  readRefs(
    name: string,
  ): Promise<readonly Readonly<{ name: string; hash: string }>[]>;
  /** Forward one supported Git protocol operation and revoke its token afterward. */
  exchangeGit(input: GitExchange): Promise<Response>;
}>;
