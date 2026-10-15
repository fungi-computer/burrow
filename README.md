# Burrow

Burrow wraps Cloudflare Artifacts.

`@fungi.computer/burrow` is the configured repository owner for Cloudflare
Artifacts. Configure `createCloudflareArtifacts` with the Workers binding and a
Publisher-owned repository metadata store at the Worker boundary. Callers
receive stable repository identity and can request only the Git smart-HTTP
operations used by Git: upload-pack and receive-pack advertisements and
exchanges. The adapter persists the exact metadata returned by `create()` and
`fork()` before later Git/head operations use the saved remote. It treats
`get()` results as opaque method handles. Publisher stages each exact create or
fork result and its initial token in a pending D1 record, retries revocation
from that record, then promotes only the metadata after that exact token is no
longer present. Pending rows do not resolve as repositories; successful
promotion clears the token. The package never returns a token or token-bearing
URL. A repeated fork recovers a destination only when Publisher has recorded
that it created the fork from the exact template; an existing destination
without that record fails closed.

Cloudflare's create/fork call and the first D1 write cannot be atomic. If the
Worker stops after the provider returns but before the pending row is committed,
the repository can remain without recorded metadata and its initial token may
remain active. The opaque `get()` handle cannot recover that result. The adapter
fails closed; recovery requires a supported provider metadata recovery path or
guarded manual cleanup outside this package.

App identity and Team authorization stay with Publisher, App Release, and Hub.
This package has no source-file API and does not decide who may use a
repository.

`readRefs(name)` returns advertised ref names and object IDs through the same
short-lived read-token owner used by `readBranchHeads(name)`. The latter keeps
its branch-only hash projection for source provenance checks. Both revoke the
token on success or failure.

## REST transport

`createArtifactsRestNamespace({ accountId, namespace, apiToken, fetch? })`
provides the host-only namespace where a Workers binding is unavailable. Use it
with `createCloudflareArtifacts` and the same repository metadata store. Oyster
uses this transport for its installation-scoped Git binding; it has no separate
REST client. Installation permission checks remain in Oyster.

REST `get(name)` only creates a name-addressed handle. `info()` and all other
handle operations make fresh provider calls; no existence, result or authority
is cached. The metadata owner explicitly probes lazy handles before accepting
repository existence/readiness.

The REST control-plane credential stays inside the transport. Requests refuse
redirects and unsuccessful HTTP responses even if their envelope claims success.
For a newly created or forked destination, the transport requires a complete
listing with exactly one active token, revokes that token's ID, and verifies its
revoked state before activation. Ambiguity or failed verification removes only
that newly created destination and refuses activation. An existing-repository
refusal never enters cleanup; a fork's source is never removed. App-facing
repository results contain neither tokens nor authenticated URLs.

REST create/fork and revocation are separate provider operations. A process
crash between them can leave an unrecorded destination; it must fail closed on
replay, just like an unrecorded Workers-binding creation. There is no guessed
token-ID codec and no cleanup of another repository's tokens.

## Install

The packed-consumer proof verifies Burrow as an Oyster runtime dependency.
Running the proof does not publish an npm release.

The root entry exports the configured Artifacts adapter and host-only REST
namespace. `@fungi.computer/burrow/cloudflare` also exports the Cloudflare
adapter and its metadata-store types.

## Quickstart

Configure the provider namespace and metadata store at the host boundary:

```ts
import {
  createCloudflareArtifacts,
  type CloudflareArtifactsOptions,
} from "@fungi.computer/burrow";

export async function openRepository(options: CloudflareArtifactsOptions) {
  const artifacts = createCloudflareArtifacts(options);
  return artifacts.resolveRepository("notes");
}
```

The supplied metadata store must implement the pending-record and activation
contract described above. Repository credentials and provider remotes remain
inside that host composition.

## Packed-consumer proof

After building Burrow, run `pnpm --dir packages/burrow run stranger` from the
repository root. The maintained checker verifies the exact tarball inventory,
installs it into a fresh npm consumer, runs local fake-provider behavior, and
compiles both entrypoints with strict NodeNext and `skipLibCheck: false`. It
makes no Cloudflare requests.

## Examples

[The local provider example](docs/home.ts) lists a repository through
`createArtifactsRestNamespace` using a fake fetch transport. It runs without
provider access or external credentials. After building Burrow, run it with:

```sh
pnpm exec tsx packages/burrow/docs/home.ts
```

The packed-consumer proof above also exercises repository resolution and
read-token cleanup through the root and Cloudflare entrypoints.
