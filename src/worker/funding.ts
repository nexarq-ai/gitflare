import { FUNDING_PLATFORMS, type FundingLink, type FundingPlatform } from '../shared/types';
import { firstFile, type SourceHandle } from './source-browse';

export const FUNDING_FILES = ['.gitflare/FUNDING.yml', '.gitflare/FUNDING.yaml', '.github/FUNDING.yml', '.github/FUNDING.yaml'] as const;
export const FUNDING_FILE_MAX_BYTES = 8192;
export const FUNDING_LINKS_MAX = 12;
const PER_PLATFORM_MAX: Partial<Record<FundingPlatform, number>> = { github: 4, custom: 4 };
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TIDELIFT = /^(?:npm|pypi|rubygems|maven|packagist|nuget)\/[A-Za-z0-9@._/-]{1,200}$/;

const PLATFORMS: Record<Exclude<FundingPlatform, 'custom'>, { label: string; url: (account: string) => string; pattern?: RegExp }> = {
  github: { label: 'GitHub Sponsors', url: account => `https://github.com/sponsors/${account}` },
  patreon: { label: 'Patreon', url: account => `https://www.patreon.com/${account}` },
  open_collective: { label: 'Open Collective', url: account => `https://opencollective.com/${account}` },
  ko_fi: { label: 'Ko-fi', url: account => `https://ko-fi.com/${account}` },
  tidelift: { label: 'Tidelift', url: account => `https://tidelift.com/funding/github/${account}`, pattern: TIDELIFT },
  community_bridge: { label: 'LFX Crowdfunding', url: account => `https://crowdfunding.lfx.linuxfoundation.org/projects/${account}` },
  liberapay: { label: 'Liberapay', url: account => `https://liberapay.com/${account}` },
  issuehunt: { label: 'IssueHunt', url: account => `https://issuehunt.io/r/${account}` },
  lfx_crowdfunding: { label: 'LFX Crowdfunding', url: account => `https://crowdfunding.lfx.linuxfoundation.org/projects/${account}` },
  polar: { label: 'Polar', url: account => `https://polar.sh/${account}` },
  buy_me_a_coffee: { label: 'Buy Me a Coffee', url: account => `https://www.buymeacoffee.com/${account}` },
  thanks_dev: { label: 'thanks.dev', url: account => `https://thanks.dev/${account}` },
};

function scalar(value: string): string {
  const text = value.replace(/\s+#.*$/, '').trim();
  if (text.length >= 2 && (text[0] === '"' && text.endsWith('"') || text[0] === "'" && text.endsWith("'"))) return text.slice(1, -1).trim();
  return text;
}

function values(inline: string, block: string[]): string[] {
  const text = inline.replace(/^\s*#.*$/, '').trim();
  if (text.startsWith('[')) {
    const end = text.lastIndexOf(']');
    return (end > 0 ? text.slice(1, end) : text.slice(1)).split(',').map(scalar).filter(Boolean);
  }
  if (text) return [scalar(text)].filter(item => item && item !== '~' && item !== 'null');
  return block.map(line => scalar(line.replace(/^\s*-\s*/, ''))).filter(item => item && item !== '~' && item !== 'null');
}

function customUrl(value: string): string | null {
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || candidate.length > 300) return null;
    return url.toString();
  } catch { return null; }
}

export function parseFunding(text: string): FundingLink[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const entries: [string, string, string[]][] = [];
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const key = /^([a-z_]+)\s*:(.*)$/.exec(line);
    if (key) { entries.push([key[1]!, key[2]!, []]); continue; }
    if (/^\s+-\s*/.test(line) && entries.length) entries[entries.length - 1]![2].push(line);
  }
  const links: FundingLink[] = [];
  const seen = new Set<string>();
  for (const [key, inline, block] of entries) {
    if (!(FUNDING_PLATFORMS as readonly string[]).includes(key)) continue;
    const platform = key as FundingPlatform;
    let count = 0;
    for (const value of values(inline, block)) {
      if (count >= (PER_PLATFORM_MAX[platform] ?? 1) || links.length >= FUNDING_LINKS_MAX) break;
      let link: FundingLink | null = null;
      if (platform === 'custom') {
        const url = customUrl(value);
        if (url) link = { platform, label: new URL(url).hostname.replace(/^www\./, ''), url };
      } else {
        const definition = PLATFORMS[platform];
        if ((definition.pattern ?? ACCOUNT).test(value)) link = { platform, label: definition.label, url: definition.url(value.split('/').map(encodeURIComponent).join('/')) };
      }
      if (!link || seen.has(link.url)) continue;
      seen.add(link.url);
      links.push(link);
      count++;
    }
  }
  return links;
}

export async function readFunding(source: SourceHandle, commitSha: string, failed?: () => void): Promise<FundingLink[]> {
  const found = await firstFile(source, commitSha, FUNDING_FILES, failed);
  if (!found || found.blob.size > FUNDING_FILE_MAX_BYTES) return [];
  return parseFunding(await found.blob.text().catch(() => { failed?.(); return ''; }));
}
