export const SOCIAL_CARD_WIDTH = 1200;
export const SOCIAL_CARD_HEIGHT = 630;
export type SocialTheme = 'dark' | 'light';

export interface SocialRepositoryCard {
  kind: 'repository';
  handle: string;
  name: string;
  description: string;
  language: string | null;
  stars: number;
  license: string | null;
  latestRelease: string | null;
  landed: { total: number; agents: number; people: number; days: number };
}

export interface SocialProfileCard {
  kind: 'profile';
  handle: string;
  displayName: string;
  bio: string;
  workspace: boolean;
  repositories: number;
  stars: number;
}

export interface SocialReleaseCard {
  kind: 'release';
  handle: string;
  name: string;
  tag: string;
  title: string;
  publishedAt: string | null;
  prerelease: boolean;
  assets: number;
}

export type SocialCard = SocialRepositoryCard | SocialProfileCard | SocialReleaseCard;

type Palette = { canvas: string; panel: string; ink: string; secondary: string; border: string; chip: string; accent: string; accentSoft: string; people: string };
const PALETTES: Record<SocialTheme, Palette> = {
  dark: { canvas: '#08090b', panel: '#101216', ink: '#eceef1', secondary: '#9aa0ab', border: 'rgba(255,255,255,0.1)', chip: 'rgba(255,255,255,0.06)', accent: '#f6821f', accentSoft: 'rgba(246,130,31,0.18)', people: '#4c8dff' },
  light: { canvas: '#fafafa', panel: '#ffffff', ink: '#23262d', secondary: '#68707d', border: 'rgba(0,0,0,0.09)', chip: 'rgba(0,0,0,0.045)', accent: '#f48120', accentSoft: 'rgba(244,129,32,0.14)', people: '#0055d4' },
};

const LANGUAGE_COLORS: Record<string, string> = { TypeScript: '#3178c6', JavaScript: '#f1e05a', Python: '#3572a5', Rust: '#dea584', Go: '#00add8', CSS: '#663399', HTML: '#e34c26', Shell: '#89e051', Ruby: '#701516', Java: '#b07219', Swift: '#f05138', Kotlin: '#a97bff', C: '#555555', 'C++': '#f34b7d', 'C#': '#178600', PHP: '#4f5d95', Dart: '#00b4ab', Zig: '#ec915c', Elixir: '#6e4a7e', Haskell: '#5e5086', Scala: '#c22d40', Lua: '#000080', SQL: '#e38c00', Vue: '#41b883', Svelte: '#ff3e00', Julia: '#a270ba', R: '#198ce7', OCaml: '#3be133', Clojure: '#db5855', Erlang: '#b83998', SCSS: '#c6538c' };

const LOGO_PATH = 'M236,64a36,36,0,1,0-48,33.94V112a4,4,0,0,1-4,4H96a27.8,27.8,0,0,0-4,.29V97.94a36,36,0,1,0-24,0v60.12a36,36,0,1,0,24,0V144a4,4,0,0,1,4-4h88a28,28,0,0,0,28-28V97.94A36.07,36.07,0,0,0,236,64ZM80,52A12,12,0,1,1,68,64,12,12,0,0,1,80,52Zm0,152a12,12,0,1,1,12-12A12,12,0,0,1,80,204ZM200,76a12,12,0,1,1,12-12A12,12,0,0,1,200,76Z';
const SANS = "'Instrument Sans'";
const SERIF = "'Instrument Serif'";
const SEMIBOLD_WIDTH = 1.06;
const STAR_PATH = 'M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6L2.5 9.4l6.6-.8z';

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

export function textWidth(value: string, size: number, weight: 'regular' | 'semibold' = 'regular'): number {
  let width = 0;
  for (const char of value) width += /[iljtfI.,:;'!| ·]/.test(char) ? 0.29 : /[mwMW@]/.test(char) ? 0.9 : /[A-Z]/.test(char) ? 0.68 : /[0-9]/.test(char) ? 0.6 : char === '…' ? 0.9 : 0.56;
  return width * size * (weight === 'semibold' ? SEMIBOLD_WIDTH : 1);
}

export function truncate(value: string, size: number, maxWidth: number, weight: 'regular' | 'semibold' = 'regular'): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (textWidth(clean, size, weight) <= maxWidth) return clean;
  let kept = clean;
  while (kept.length && textWidth(`${kept}…`, size, weight) > maxWidth) kept = kept.slice(0, -1);
  return `${kept.trimEnd()}…`;
}

export function wrap(value: string, size: number, maxWidth: number, maxLines: number): string[] {
  const words = value.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size) <= maxWidth) { line = candidate; continue; }
    if (line) lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length > maxLines || (lines.length === maxLines && words.join(' ') !== lines.join(' '))) {
    lines.length = maxLines;
    lines[maxLines - 1] = truncate(`${lines[maxLines - 1]} …`, size, maxWidth);
  }
  return lines.map(item => truncate(item, size, maxWidth));
}

export function compactNumber(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function landedLine(landed: SocialRepositoryCard['landed']): string {
  if (!landed.total) return `No revisions landed in the last ${landed.days} days`;
  const who = [landed.agents ? `${landed.agents} by agents` : '', landed.people ? `${landed.people} by people` : ''].filter(Boolean).join(' · ');
  return `${landed.total} revision${landed.total === 1 ? '' : 's'} landed in ${landed.days} days${who ? ` · ${who}` : ''}`;
}

function text(x: number, y: number, value: string, size: number, fill: string, options: { weight?: 'regular' | 'semibold'; family?: string; anchor?: 'start' | 'end' | 'middle'; letterSpacing?: number } = {}): string {
  const weight = options.weight === 'semibold' ? ' font-weight="600"' : '';
  const spacing = options.letterSpacing ? ` letter-spacing="${options.letterSpacing}"` : '';
  const anchor = options.anchor ? ` text-anchor="${options.anchor}"` : '';
  return `<text x="${x}" y="${y}" font-family="${options.family ?? SANS}" font-size="${size}" fill="${fill}"${weight}${spacing}${anchor}>${escapeXml(value)}</text>`;
}

type Chip = { label: string; dot?: string; star?: boolean };

function chip(x: number, y: number, item: Chip, palette: Palette): { svg: string; width: number } {
  const size = 24;
  const padding = 18;
  const leadWidth = item.dot ? 22 : item.star ? 28 : 0;
  const width = Math.ceil(textWidth(item.label, size) + padding * 2 + leadWidth);
  const height = 44;
  const parts = [`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="22" fill="${palette.chip}" stroke="${palette.border}"/>`];
  if (item.dot) parts.push(`<circle cx="${x + padding + 6}" cy="${y + height / 2}" r="6" fill="${item.dot}"/>`);
  if (item.star) parts.push(`<g transform="translate(${x + padding - 2} ${y + 11}) scale(0.9)"><path d="${STAR_PATH}" fill="${palette.accent}"/></g>`);
  parts.push(text(x + padding + leadWidth, y + 30, item.label, size, palette.ink));
  return { svg: parts.join(''), width };
}

function chips(x: number, y: number, labels: Chip[], palette: Palette, maxWidth: number): string {
  let cursor = x;
  const parts: string[] = [];
  for (const item of labels) {
    const drawn = chip(cursor, y, item, palette);
    if (cursor + drawn.width > x + maxWidth) break;
    parts.push(drawn.svg);
    cursor += drawn.width + 12;
  }
  return parts.join('');
}

function frame(theme: SocialTheme, body: string, footerRight: string): string {
  const palette = PALETTES[theme];
  const wordmarkX = 64;
  const wordmarkY = 566;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SOCIAL_CARD_WIDTH}" height="${SOCIAL_CARD_HEIGHT}" viewBox="0 0 ${SOCIAL_CARD_WIDTH} ${SOCIAL_CARD_HEIGHT}">
<defs>
<radialGradient id="glow" cx="1080" cy="-40" r="620" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${palette.accent}" stop-opacity="${theme === 'dark' ? 0.34 : 0.22}"/><stop offset="1" stop-color="${palette.accent}" stop-opacity="0"/></radialGradient>
</defs>
<rect width="${SOCIAL_CARD_WIDTH}" height="${SOCIAL_CARD_HEIGHT}" fill="${palette.canvas}"/>
<rect width="${SOCIAL_CARD_WIDTH}" height="${SOCIAL_CARD_HEIGHT}" fill="url(#glow)"/>
<rect x="0.5" y="0.5" width="${SOCIAL_CARD_WIDTH - 1}" height="${SOCIAL_CARD_HEIGHT - 1}" fill="none" stroke="${palette.border}"/>
${body}
<g transform="translate(${wordmarkX} ${wordmarkY - 30})"><rect width="40" height="40" rx="9" fill="#e88932"/><g transform="translate(7.5 7.5) scale(0.0977)"><path d="${LOGO_PATH}" fill="#fff"/></g></g>
${text(wordmarkX + 54, wordmarkY + 2, 'Git', 30, palette.ink, { weight: 'semibold', letterSpacing: -0.6 })}${text(wordmarkX + 99, wordmarkY + 2, 'flare', 32, palette.accent, { family: SERIF })}
${text(SOCIAL_CARD_WIDTH - 64, wordmarkY + 2, footerRight, 22, palette.secondary, { anchor: 'end' })}
</svg>`;
}

function repositoryBody(card: SocialRepositoryCard, theme: SocialTheme): string {
  const palette = PALETTES[theme];
  const left = 64;
  const width = SOCIAL_CARD_WIDTH - left * 2;
  const parts: string[] = [];
  parts.push(text(left, 102, `${card.handle} /`, 26, palette.secondary));
  parts.push(text(left, 182, truncate(card.name, 68, width, 'semibold'), 68, palette.ink, { weight: 'semibold', letterSpacing: -1.6 }));
  const description = card.description.trim() ? wrap(card.description, 28, width, 2) : ['A public repository on Gitflare.'];
  description.forEach((line, index) => parts.push(text(left, 236 + index * 38, line, 28, palette.secondary)));
  const facts: Chip[] = [];
  if (card.language) facts.push({ label: card.language, dot: LANGUAGE_COLORS[card.language] ?? palette.secondary });
  facts.push({ label: compactNumber(card.stars), star: true });
  if (card.license) facts.push({ label: card.license });
  if (card.latestRelease) facts.push({ label: `Latest ${card.latestRelease}` });
  parts.push(chips(left, 332, facts, palette, width));
  const barY = 430;
  const barWidth = width;
  const total = card.landed.total;
  parts.push(`<rect x="${left}" y="${barY}" width="${barWidth}" height="10" rx="5" fill="${palette.chip}"/>`);
  if (total) {
    const agentWidth = Math.round(barWidth * card.landed.agents / total);
    if (agentWidth) parts.push(`<rect x="${left}" y="${barY}" width="${agentWidth}" height="10" rx="5" fill="${palette.accent}"/>`);
    if (agentWidth < barWidth) parts.push(`<rect x="${left + agentWidth}" y="${barY}" width="${barWidth - agentWidth}" height="10" rx="5" fill="${palette.people}"/>`);
  }
  parts.push(text(left, 478, landedLine(card.landed), 24, palette.ink));
  return parts.join('\n');
}

function profileBody(card: SocialProfileCard, theme: SocialTheme): string {
  const palette = PALETTES[theme];
  const left = 64;
  const avatar = 104;
  const parts: string[] = [];
  const name = card.displayName.trim() || card.handle;
  const initials = name.split(/[\s_-]+/).filter(Boolean).map(word => word[0]!).slice(0, 2).join('').toUpperCase() || '?';
  parts.push(`<circle cx="${left + avatar / 2}" cy="${118 + avatar / 2}" r="${avatar / 2}" fill="${palette.accentSoft}" stroke="${palette.border}"/>`);
  parts.push(text(left + avatar / 2, 118 + avatar / 2 + 15, initials, 42, palette.accent, { weight: 'semibold', anchor: 'middle' }));
  const textLeft = left + avatar + 36;
  const width = SOCIAL_CARD_WIDTH - textLeft - left;
  parts.push(text(textLeft, 164, truncate(name, 60, width, 'semibold'), 60, palette.ink, { weight: 'semibold', letterSpacing: -1.4 }));
  parts.push(text(textLeft, 208, `@${card.handle}${card.workspace ? ' · Workspace' : ''}`, 26, palette.secondary));
  const bio = card.bio.trim() ? wrap(card.bio, 28, SOCIAL_CARD_WIDTH - left * 2, 2) : [card.workspace ? 'A workspace on Gitflare.' : 'Builds with people and agents on Gitflare.'];
  bio.forEach((line, index) => parts.push(text(left, 300 + index * 38, line, 28, palette.secondary)));
  parts.push(chips(left, 392, [{ label: `${card.repositories} public ${card.repositories === 1 ? 'repository' : 'repositories'}` }, { label: `${compactNumber(card.stars)} received`, star: true }], palette, SOCIAL_CARD_WIDTH - left * 2));
  return parts.join('\n');
}

function releaseBody(card: SocialReleaseCard, theme: SocialTheme): string {
  const palette = PALETTES[theme];
  const left = 64;
  const width = SOCIAL_CARD_WIDTH - left * 2;
  const parts: string[] = [];
  parts.push(text(left, 102, `${card.handle} / ${card.name}`, 26, palette.secondary));
  parts.push(text(left, 140, card.prerelease ? 'PRE-RELEASE' : 'RELEASE', 18, palette.accent, { weight: 'semibold', letterSpacing: 2.5 }));
  parts.push(text(left, 230, truncate(card.tag, 84, width, 'semibold'), 84, palette.ink, { weight: 'semibold', letterSpacing: -2.4 }));
  if (card.title.trim() && card.title.trim() !== card.tag) parts.push(text(left, 290, truncate(card.title, 32, width), 32, palette.secondary));
  const facts: Chip[] = [];
  if (card.publishedAt) {
    const date = new Date(card.publishedAt);
    if (!Number.isNaN(date.getTime())) facts.push({ label: date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) });
  }
  if (card.assets) facts.push({ label: `${card.assets} ${card.assets === 1 ? 'file' : 'files'}` });
  parts.push(chips(left, 352, facts, palette, width));
  return parts.join('\n');
}

export function socialCardSvg(card: SocialCard, theme: SocialTheme = 'dark', site = 'gitflare.io'): string {
  if (card.kind === 'repository') return frame(theme, repositoryBody(card, theme), truncate(`${site}/${card.handle}/${card.name}`, 22, 520));
  if (card.kind === 'profile') return frame(theme, profileBody(card, theme), truncate(`${site}/${card.handle}`, 22, 520));
  return frame(theme, releaseBody(card, theme), truncate(`${site}/${card.handle}/${card.name}/releases`, 22, 520));
}
