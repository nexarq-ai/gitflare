# Mirror to GitHub

A Gitflare repository is the source of truth. A GitHub mirror is a downstream copy: Gitflare pushes to it, and nothing on GitHub flows back unless an Owner imports it. Use it to keep a public or backup copy on GitHub, to feed GitHub-only tooling, or while moving an existing project onto Gitflare.

Status: source and unit tests only. The protocol code is tested against real `git upload-pack` and `git receive-pack` processes; it has not yet been run against github.com from a deployed Gitflare. Import from GitHub is tested against a mocked GitHub REST API and real Git processes only.

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

## Import issues, pull requests and releases

The mirror moves code. **Import from GitHub** (Settings → General, below the mirror) copies the rest, so a project can move without losing its history. Only workspace Owners can run it.

1. Import the code first: **New repository → Import from a Git URL** (every branch and tag with full history) or **Adopt from GitHub**.
2. Enter the GitHub owner and repository, choose issues, pull requests and releases, and choose access:
   - **Public, no token** for public repositories, within GitHub's limit of 60 API requests an hour.
   - **Mirror credential** when the mirror links the same GitHub repository.
   - **Fine-grained token** with read access to Contents, Issues, Pull requests and Metadata. It raises the rate limit and reads private repositories. Like the mirror token, it is accepted only in a signed-in browser, stored encrypted and never returned. It is deleted when the import finishes unless you keep it for the hourly pull.
3. Choose **Import from GitHub** and follow the counts.

What arrives:

- **Labels** with their colours and descriptions (up to 100).
- **Issues and comments** in their original order. When the repository has no issues yet, GitHub numbers are kept; otherwise issues get the next free numbers and link back to GitHub. GitHub people appear as `github:<login>`; they are never matched to Gitflare accounts. Bodies are kept as Markdown and shown with Gitflare's safe renderer (no HTML, no images, external links only).
- **Open pull requests** become draft proposals from a stream named `github-pr/<n>`, fetched from GitHub's `refs/pull/<n>/head` at its exact commit. Checks do not start until a Maintainer starts them.
- **Closed pull requests** become closed issues for history, marked as merged or not.
- **Releases** for tags that are already in the repository, with their notes and links to the assets on GitHub. Drafts and releases whose tag is missing are skipped.

Anything that cannot be imported is listed under **Skipped** with the reason. Running the import again picks up edits and new items and never duplicates what is already there. When GitHub's rate limit is reached, the import waits until it resets and continues; **Resume** restarts a stopped import where it left off.

### While you move

Turn on **Pull GitHub issues hourly** to keep copying new GitHub issues and comments while GitHub stays open. Comments made in Gitflare are not sent to GitHub; imported issues link back so people know where the conversation started. When you are done, choose **Make Gitflare canonical**: the hourly pull stops, the stored token is deleted and, if you keep **Notice on GitHub** on and the token may write issues, Gitflare opens an issue on GitHub pointing here.

### A whole organization

**New repository → Import from a Git URL → Import a GitHub organization** lists an organization's or user's repositories. Choose up to 20: each becomes a Gitflare repository with its code and then its issues, pull requests and releases. Private repositories need a token, which is stored separately for each repository.

## MCP

`gitflare_github_import` reads an import's progress and `gitflare_import_github` starts, resumes, cancels and controls it. `gitflare_github_organization` lists organization repositories and imports, and `gitflare_import_github_organization` imports several at once. They use the same Owner checks as the UI and never accept a token: `credential-setup` returns the browser URL.

`gitflare_github_mirror` reads the status. `gitflare_manage_github_mirror` links, unlinks, syncs, imports, overwrites and adopts with the same Owner checks and audit records as the UI. Its `credential-setup` action returns the browser URL, because tokens never pass through MCP. No tool returns the credential.

## Limits

- GitHub over HTTPS only, SHA-1 repositories, and packs up to 512 MiB per sync.
- Divergence checks look back 1,000 commits from Gitflare's tip. A GitHub commit older than that counts as diverged.
- GitHub branch protection still applies: a protected GitHub branch that rejects the push shows the ref as Failed with GitHub's reason.
- Git LFS objects are not mirrored. GitHub issues, pull requests and releases come over with Import from GitHub, not the mirror.
- Imports keep at most 50,000 issues and 500 comments per issue, 500 releases and 100 labels per repository. Milestones, reactions, review comments on code and release asset files are not imported.
