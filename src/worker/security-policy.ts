import type { Repository, SecurityPolicy } from '../shared/types';
import type { AppEnv } from './env';
import type { SourceHandle } from './source-browse';

export const SECURITY_POLICY_FILES = ['.gitflare/SECURITY.md', '.github/SECURITY.md', 'SECURITY.md', 'docs/SECURITY.md'] as const;
const SECURITY_POLICY_MAX = 65_536;

export async function readSecurityPolicy(source: SourceHandle, commitSha: string): Promise<SecurityPolicy | null> {
  for (const path of SECURITY_POLICY_FILES) {
    const blob = await source.readFile({ ref: commitSha, path }).catch(() => null);
    if (!blob) continue;
    if (blob.size > SECURITY_POLICY_MAX) return { path, content: '' };
    return { path, content: await blob.text().catch(() => '') };
  }
  return null;
}

export async function repositorySecurityPolicy(env: Pick<AppEnv, 'ARTIFACTS'>, repository: Repository): Promise<SecurityPolicy | null> {
  if (!env.ARTIFACTS || repository.provider !== 'artifacts') return null;
  using source = await env.ARTIFACTS.get(repository.name);
  const commit = (await source.log({ ref: repository.defaultBranch, limit: 1 }).catch(() => []))[0];
  return commit ? await readSecurityPolicy(source, commit.hash) : null;
}
