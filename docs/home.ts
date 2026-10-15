import { createArtifactsRestNamespace } from "@fungi.computer/burrow";

// Local provider fixture: this example never contacts Cloudflare.
const namespace = createArtifactsRestNamespace({
  accountId: "example-account",
  namespace: "default",
  apiToken: "example-only",
  fetch: async () =>
    Response.json({
      success: true,
      errors: [],
      result: [
        {
          id: "repository-notes",
          name: "notes",
          default_branch: "main",
          remote:
            "https://example.artifacts.cloudflare.net/git/default/notes.git",
          status: "ready",
        },
      ],
      result_info: { total_pages: 1, total_count: 1 },
    }),
});

const { repos } = await namespace.list();
console.log(repos.map((repository) => repository.name)); // ["notes"]
