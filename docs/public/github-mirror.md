# Mirror to GitHub

A Gitflare repository is the source of truth. A GitHub mirror is a downstream copy: Gitflare pushes to it, and nothing on GitHub flows back unless an Owner imports it. Use it to keep a public or backup copy on GitHub, to feed GitHub-only tooling, or while moving an existing project onto Gitflare.

Status: source and unit tests only. The protocol code is tested against real `git upload-pack` and `git receive-pack` processes; it has not yet been run against github.com from a deployed Gitflare.

## Set it up

Open the repository, choose the **Streams** tab and scroll to **GitHub mirror**. Only workspace Owners can change it.

1. Enter the GitHub owner and repository name, and choose the refs to mirror. The default is the repository's default branch and every tag: `refs/heads/main` and `refs/tags/*`. Use `*` as a wildcard, for example `refs/heads/release/*`.
2. Choose **Link GitHub repository**.
3. Add a credential:
   - **Fine-grained personal access token.** On GitHub open Settings → Developer settings → Fine-grained tokens → Generate new token. Under Repository access, choose **Only select repositories** and pick the mirror repository. Under Repository permissions, set **Contents: Read and write**. Leave everything else at No access. Paste the token and choose **Save token**.
   - **GitHub App installation** (only in the installation workspace, when the operator configured a GitHub App). Install the App on the repository, then paste the installation ID from the installation URL.

Gitflare checks that the credential can push to the repository before storing it. A token is encrypted with the installation's `AUTH_ENCRYPTION_KEY`, bound to this repository, and never shown again. It is not returned by the API or MCP, written to logs, or given to coding agents: mirroring runs in the Gitflare Worker and never in an agent container. Tokens are accepted only from a signed-in browser; API and MCP clients get `BROWSER_REQUIRED`.

## What gets pushed, and when

After every landing, `git push` to Gitflare, stream change or release that touches a mirrored ref, Gitflare starts a background sync. **Sync now** starts one immediately. A sync compares each mirrored ref on both sides and pushes the Gitflare value to GitHub:

- If GitHub still has the commit Gitflare last pushed, Gitflare's value replaces it, even when Gitflare's history was rewound. This is force-with-lease: the push names the GitHub commit it expects, so a concurrent change on GitHub makes the push fail rather than disappear.
- If GitHub's commit is already part of Gitflare's history, the push is a fast-forward.
- Refs deleted in Gitflare are deleted on GitHub, under the same lease.

Transient failures (GitHub unreachable, 5xx, a lost lease race) are retried with exponential backoff, up to six retries. Each ref shows its state, the Gitflare and GitHub commits, the last synced commit and time, and the last error. Only one sync runs per repository; a trigger that arrives during a sync runs again when it finishes.

If the Owner who stored the credential loses Owner rights on the repository, syncing stops until an Owner adds the credential again.

## When GitHub has commits Gitflare does not

If someone pushes to GitHub directly, the mirror does not overwrite it. The ref is marked **Diverged** and stays that way until an Owner chooses one of:

- **Import from GitHub** copies the GitHub commit into a new stream named `github-import/<branch>-<sha7>` (tags go to `refs/tags/github-import/…`). Open a proposal from it and land it the normal way. Once Gitflare's branch contains the GitHub commit, the next sync is a fast-forward and the divergence clears.
- **Overwrite GitHub** replaces the GitHub ref with Gitflare's commit. The request carries the GitHub commit shown on screen; if GitHub moved again since, nothing is overwritten. Overwrites are recorded in the audit log.

## Adopt from GitHub

To move an existing GitHub project onto Gitflare, create an empty repository (or one with only its setup commit), link the mirror and add the credential, then choose **Adopt from GitHub**. Gitflare copies the mirrored refs once and records the adoption. From then on Gitflare is the source of truth and pushes to GitHub. Adopt is refused once the repository has its own history; use Import from GitHub instead. To import every branch with full history into a new repository, use **Import from URL**.

## MCP

`gitflare_github_mirror` reads the status. `gitflare_manage_github_mirror` links, unlinks, syncs, imports, overwrites and adopts with the same Owner checks and audit records as the UI. Its `credential-setup` action returns the browser URL, because tokens never pass through MCP. No tool returns the credential.

## Limits

- GitHub over HTTPS only, SHA-1 repositories, and packs up to 512 MiB per sync.
- Divergence checks look back 1,000 commits from Gitflare's tip. A GitHub commit older than that counts as diverged.
- GitHub branch protection still applies: a protected GitHub branch that rejects the push shows the ref as Failed with GitHub's reason.
- Git LFS objects, GitHub issues, pull requests and releases are not mirrored; only Git refs and their objects.
