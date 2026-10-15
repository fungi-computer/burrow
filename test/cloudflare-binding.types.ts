/// <reference types="@cloudflare/workers-types" />

import type { CloudflareArtifactsNamespace } from "../src/cloudflare.js";

type Assert<T extends true> = T;
type MaintainedBindingFits = Assert<
  Artifacts extends CloudflareArtifactsNamespace ? true : false
>;
const maintainedBindingFits: MaintainedBindingFits = true;
void maintainedBindingFits;

type PublicRepositoryHandle = Awaited<
  ReturnType<CloudflareArtifactsNamespace["get"]>
>;

const independentlyDeclaredHandle: PublicRepositoryHandle = {
  createToken: (scope: "read" | "write", ttlSeconds: number) => {
    void scope;
    void ttlSeconds;
    return Promise.resolve({
      id: "fixture-id",
      plaintext: "fixture-token",
      expiresAt: "fixture-expiry",
    });
  },
  revokeToken: (tokenOrId: string) => {
    void tokenOrId;
    return Promise.resolve(true);
  },
  fork: (
    name: string,
    options: { readOnly: false; defaultBranchOnly: true },
  ) => {
    void options;
    return Promise.resolve({
      id: `fixture-${name}`,
      name,
      remote: `https://account.artifacts.cloudflare.net/git/default/${name}.git`,
      defaultBranch: "main",
      token: "fixture-token",
    });
  },
};

const independentlyDeclaredNamespace: CloudflareArtifactsNamespace = {
  get: (name: string) => {
    void name;
    return Promise.resolve(independentlyDeclaredHandle);
  },
  list: (options?: { limit?: number; cursor?: string }) => {
    void options;
    return Promise.resolve({ repos: [], total: 0 });
  },
  create: (
    name: string,
    options: { readOnly: false; setDefaultBranch: "main" },
  ) => {
    void options;
    return Promise.resolve({
      id: "fixture-id",
      name,
      remote: `https://account.artifacts.cloudflare.net/git/default/${name}.git`,
      defaultBranch: "main",
      token: "fixture-token",
    });
  },
};
void independentlyDeclaredNamespace;
