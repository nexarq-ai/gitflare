import type { Repository } from "../shared/types";
import type { CloudflareFeature } from "../shared/cloudflare-permissions";
import { repositoryLabel } from "../shared/repository-names";

export type AccountsOverview = {
  connected: boolean;
  defaultAccount: { id: string; name: string } | null;
  accounts: { id: string; name: string; grantId: string | null }[];
  repositories: Record<string, { accountId?: string; environments?: Record<string, string>; own?: { id: string; name: string } | true }>;
  grants?: string[];
};

export const FEATURE_LABELS: Record<CloudflareFeature, string> = { deploy: "Deploy Workers", previews: "Worker previews", secrets: "Secrets", access: "Cloudflare Access" };

export const FEATURE_HELP: Record<CloudflareFeature, string> = {
  deploy: "Lets Gitflare upload Workers and create D1 databases when you deploy. Without it, deploys stop before they start.",
  previews: "Lets each proposal get its own preview of your Worker, with a separate D1 database. Without it, previews run on Gitflare's shared previews Worker.",
  secrets: "Lets repositories use values from Cloudflare Secrets Store. Gitflare never shows a secret's value.",
  access: "Lets Gitflare put a deployed environment or preview behind a Cloudflare Access login.",
};

export function accountUsage(accountId: string, overview: AccountsOverview | null, repositories: Repository[]) {
  if (!overview) return [];
  return repositories.flatMap(repository => {
    const selection = overview.repositories[repository.id];
    if (!selection) return [];
    const environments = Object.entries(selection.environments ?? {}).filter(([, id]) => id === accountId).map(([name]) => name);
    if (selection.accountId === accountId) return [{ repository, where: environments.length ? `All environments` : "Repository account" }];
    return environments.length ? [{ repository, where: environments.join(", ") }] : [];
  });
}

export function removeRefusal(accountId: string, overview: AccountsOverview | null, repositories: Repository[]): string {
  const used = accountUsage(accountId, overview, repositories);
  if (!used.length) return "Repositories still deploy to this account. Choose another account for them first.";
  const first = repositoryLabel(used[0].repository);
  return used.length === 1 ? `${first} deploys to this account. Choose another account for it first.` : `${first} and ${used.length - 1} other ${used.length === 2 ? "repository" : "repositories"} deploy to this account. Choose another account for them first.`;
}
