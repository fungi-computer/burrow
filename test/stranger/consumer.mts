import {
  createCloudflareArtifacts,
  createArtifactsRestNamespace,
  type Artifacts,
  type ArtifactsNamespace,
  type ArtifactsRepository,
  type GitExchange,
} from "@fungi.computer/burrow";
import {
  createCloudflareArtifacts as cloudflareArtifacts,
  type CloudflareArtifactsOptions,
  type CloudflareArtifactsRepositoryMetadataStore,
} from "@fungi.computer/burrow/cloudflare";

export function configuredHost(options: CloudflareArtifactsOptions): Artifacts {
  return createCloudflareArtifacts(options);
}
export const cloudflareHost: typeof createCloudflareArtifacts =
  cloudflareArtifacts;
export const restHost: typeof createArtifactsRestNamespace =
  createArtifactsRestNamespace;
export type HostPorts = [
  ArtifactsNamespace,
  CloudflareArtifactsRepositoryMetadataStore,
];
export async function exchange(
  host: Artifacts,
  input: GitExchange,
): Promise<Response> {
  return host.exchangeGit(input);
}
export async function repository(
  host: Artifacts,
): Promise<ArtifactsRepository> {
  return host.resolveRepository("notes");
}
