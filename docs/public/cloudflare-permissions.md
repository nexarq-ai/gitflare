# What Gitflare asks Cloudflare for

Gitflare uses Cloudflare authorization twice, for different things. Signing in proves who you are. Connecting an account lets a workspace see and deploy to that account. Each asks only for what it needs, and you see the full list before Cloudflare's consent screen opens.

## Signing in

**Sign in with Cloudflare** (hosted edition) requests one permission:

| Permission | Scope | Why |
| --- | --- | --- |
| User Details Read | `user-details.read` | Read your Cloudflare user ID, name and email to sign you in. |

Gitflare reads your identity once, then revokes the token at Cloudflare. It is never stored, it cannot read your accounts, Workers or databases, and signing in does not connect an account to your workspace.

## Connecting an account

An Owner connects an account in **Settings → Cloudflare**, or for one repository in its **Cloudflare** tab. Before Gitflare sends you to Cloudflare, it lists each permission it will request and why. The list comes from the same configuration as the authorization request, so it always matches what Cloudflare shows. MCP clients get the same list from `gitflare_cloudflare_connection` with `status` or `connect`.

Every installation requests these:

| Permission | Scope | Why |
| --- | --- | --- |
| Offline access | `offline_access` | Refresh the connection so resources and deploys keep working without re-authorizing every hour. |
| Account Settings Read | `account-settings.read` | List the accounts you granted so you can choose one for this workspace. |
| Workers Scripts Metadata Read | `workers-scripts.metadata_read` | List your Workers and Durable Object namespaces to link them to repositories. |
| D1 Read | `d1.read` | List your D1 databases to link them to repositories. |
| D1 Write | `d1.write` | Apply D1 migrations an Owner reviewed and confirmed, and create databases a deploy declares. |
| Account Analytics Read | `account-analytics.read` | Show request, error and query counts for linked Workers and D1 databases. |
| Containers Read | `containers.read` | List your Container applications to link them to repositories. |

An installation that deploys Workers also requests these:

| Permission | Scope | Why |
| --- | --- | --- |
| Workers Scripts Edit | `workers-scripts.edit` | Upload and deploy your Workers and their previews when you land or deploy a change. |
| Workers R2 Storage Write | `workers-r2.write` | Create the R2 buckets a deployed Worker declares in its Wrangler configuration. |
| Queues Write | `queues.write` | Create the queues a deployed Worker produces to or consumes from. |
| Workers Routes Write | `workers-routes.write` | Attach the custom domains a deployed Worker declares. |
| Workers AI Write | `ai.write` | Bind Workers AI to a deployed Worker that declares it. |
| Secrets Store Read | `secrets-store.read` | Requested only when you turn on repository secrets. List the Secrets Store secrets you can link to a repository, by name only. |
| Secrets Store Write | `secrets-store.write` | Requested only when you turn on repository secrets. Create or rotate a secret you enter and bind linked secrets to your deployed Workers. Gitflare never reads a secret's value back. |

## Optional permissions

An installation's operator chooses whether to request these. If they are not requested, or the grant lacks them, the rest of the connection keeps working:

| Permission | Scope | If it is missing |
| --- | --- | --- |
| Zone Read | `zone.read` | Gitflare cannot look up a custom domain's zone. Add `zone_id` to that route in the Wrangler configuration yourself. |
| Workers Scripts Read | `workers-scripts.read` | Linked Worker details beyond names are unavailable. |
| Workflows Read | `workflows.read` | Workflows do not appear in the resource catalog. |
| Access: Apps and Policies Edit | set by the operator | Previews cannot be put behind Cloudflare Access; they stay reachable by link only. |

Without the deploy permissions, Gitflare still links resources, shows usage and applies reviewed D1 migrations; deploy and Worker Preview actions explain which permission is missing.

## What Gitflare never does

- It never changes account settings, members, API tokens or billing.
- It never edits DNS records directly. Attaching a custom domain that a Worker's Wrangler configuration declares lets Cloudflare create that hostname's record.
- It never deploys, migrates or creates resources on its own. Each action follows an Owner's explicit request, a reviewed migration, or a landed change in a repository configured to deploy.
- It never gives a connection token to coding agents, MCP clients or the browser.

## Token storage

A connection's tokens are encrypted with AES-GCM under the installation's encryption key, bound to the workspace (or repository) they belong to, and stored only in Gitflare's security service. Each workspace has its own connection; a repository can have its own instead. Owners can see which account is connected and which permissions were granted, never the token.

## Revoking access

- In Gitflare, **Settings → Cloudflare → Disconnect** deletes the stored connection and revokes its tokens at Cloudflare. A repository's own connection has its own **Disconnect**.
- In the Cloudflare dashboard, remove Gitflare from the applications your profile has authorized. Gitflare then shows the connection as failing until an Owner reconnects or disconnects it.

Signing in again never restores a disconnected account; only **Connect Cloudflare** does.
