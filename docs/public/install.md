# Install on Cloudflare

Gitflare's self-hosted edition is Apache-2.0 and published at [nexarq-ai/gitflare](https://github.com/nexarq-ai/gitflare). The Deploy button installs it from that repository into your own Cloudflare account. Nothing connects to hosted Gitflare.

[![Deploy Gitflare to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fnexarq-ai%2Fgitflare)

Status: a fresh install through the Deploy button has not yet been tested end to end. If something breaks, open an issue on the repository.

![Cloudflare deploys the GitHub source into your account; account-owned services and secrets are configured there, with preview deployed separately](../../src/ui/assets/docs/architecture.svg)

## Before you start

- A Cloudflare account with Workers, Artifacts, Containers, Durable Objects, Workflows, KV and AI Gateway. Containers require the Workers Paid plan.
- A Build credential for the Worker with Workers, Containers, Workflows and KV access plus **AI Gateway Read/Write** and **Artifacts Read/Edit**. The default Build credential lacks the last two; grant them under the Worker's **Settings → Builds** before deploying, or provisioning stops at preflight with a permission error. Never paste this credential into Gitflare.
- Provider credentials, or Unified Billing, on the `gitflare` AI Gateway. Every model call goes through it. Provisioning creates the Gateway and an Artifacts namespace named after your Worker (`gitflare` by default) if they do not exist, and leaves existing ones unchanged.
- Optional: a verified Cloudflare Email Sending sender as `EMAIL_FROM`, if you want invitation emails.

## Deploy

1. Choose **Deploy to Cloudflare** above and authorize Cloudflare to read the public repository.
2. Pick the account and Worker name. Set `ADMIN_EMAIL` and an `ADMIN_PASSWORD` of at least 12 characters. These are the first administrator's credentials.
3. Grant the Build credential the permissions listed above. Provisioning then checks them, creates or reuses the Gateway and Artifacts namespace, creates OAuth KV, generates `AUTH_ENCRYPTION_KEY` if none exists, and deploys the main Worker and a separate preview Worker. The key is kept on later deployments; back it up, because stored tokens and connections cannot be decrypted without it.
4. Add provider credentials or Unified Billing to the `gitflare` Gateway. Sign in and, on **AI models**, add the Gateway or Workers AI models you want. **Verify** sends one small request; start a small Mission to confirm the model can use tools.
5. Open the Worker URL, sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`, enter a display name and workspace name, enroll a TOTP authenticator, and store the ten recovery codes. The preview URL is a different origin from the main one.
6. Turn on Worker Previews from **Settings → Cloudflare → Previews and deploys on this installation**. The card opens Cloudflare's token page with **Workers Scripts: Edit** and **D1: Edit** prefilled; paste the token back and Gitflare verifies it, creates the `<name>-previews` Worker if needed, and stores it encrypted. Without D1: Edit, previews of apps that bind D1 fail and the card says so. You can instead pass the token once as `GITFLARE_CLOUDFLARE_TOKEN` when deploying.

`.dev.vars.example` lists `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Keep every credential in Cloudflare's secret store or a local env file that is never committed, put in an issue, or pasted into a prompt.

## Install from a terminal instead

Download the source archive and manifest from the Source page, verify them, then with Node.js 24 and a Wrangler login:

```sh
npm ci
node scripts/install-self-hosted.mjs
```

The installer writes account-specific main and preview configurations for you to review, then provisions the Gateway, namespace, OAuth KV, encryption key, runner and both Workers. Existing resources and an existing encryption key are reused.

![Your account owns the Worker, Artifacts namespace, AI Gateway, runner image, OAuth storage, email sender, and separate preview origin](../../src/ui/assets/docs/trust.svg)

## After the first sign-in

Create or invite a second user, browse a repository, and connect an MCP client. Then read [workspace administration](admin.md), [repositories and changes](repositories.md) and the [MCP guide](mcp.md). Billing, logs and backups are yours to watch in your Cloudflare account.
