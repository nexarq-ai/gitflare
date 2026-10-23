import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { publicRepositoryPath } from '../shared/handles';
import { isDeployBadgeSource, markdownImageSource, resolveRepositoryPath, type MarkdownImageContext } from '../shared/markdown-images';

type Node = {
  type: string; value?: string; depth?: number; ordered?: boolean | null; start?: number | null; checked?: boolean | null; lang?: string | null;
  url?: string; alt?: string | null; title?: string | null; identifier?: string; align?: (string | null)[] | null; children?: Node[];
};

export interface MarkdownOptions extends MarkdownImageContext { ref?: string; headingOffset?: number }

export const MARKDOWN_HTML_MAX = 200_000;
const ABSOLUTE = /^(?:https?:|mailto:)/i;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

function parse(markdown: string): Node {
  return fromMarkdown(markdown.slice(0, MARKDOWN_HTML_MAX), { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as Node;
}

function definitions(tree: Node): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (node: Node) => {
    if (node.type === 'definition' && node.identifier !== undefined && !found.has(node.identifier)) found.set(node.identifier, node.url ?? '');
    node.children?.forEach(walk);
  };
  walk(tree);
  return found;
}

export function plainText(node: Node): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? '';
  if (node.type === 'image' || node.type === 'imageReference' || node.type === 'html') return '';
  if (node.type === 'break') return ' ';
  return (node.children ?? []).map(plainText).join('');
}

export function markdownSummary(markdown: string, max = 200): string {
  let tree: Node;
  try { tree = parse(markdown); } catch { return ''; }
  for (const node of tree.children ?? []) {
    if (node.type !== 'paragraph') continue;
    const text = plainText(node).replace(/\s+/g, ' ').trim();
    if (text.length >= 20) return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  }
  return '';
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');
}

export function markdownToHtml(markdown: string, options: MarkdownOptions = {}): string {
  let tree: Node;
  try { tree = parse(markdown); } catch { return `<p>${escapeHtml(markdown.slice(0, MARKDOWN_HTML_MAX))}</p>`; }
  const links = definitions(tree);
  const slugs = new Map<string, number>();
  const offset = options.headingOffset ?? 0;
  const repository = options.repository;

  const href = (target: string): { href: string; external: boolean } | null => {
    if (ABSOLUTE.test(target)) return { href: target, external: true };
    if (target.startsWith('#')) return { href: target, external: false };
    if (!repository) return null;
    const resolved = resolveRepositoryPath(target, repository.path);
    if (resolved === null) return null;
    const clean = resolved.replace(/\/+$/, '');
    const path = clean ? publicRepositoryPath(repository.handle, repository.name, resolved.endsWith('/') ? 'tree' : 'blob', clean) : publicRepositoryPath(repository.handle, repository.name);
    return { href: options.ref ? `${path}?${new URLSearchParams({ ref: options.ref })}` : path, external: false };
  };

  const image = (source: string, alt: string): string => {
    const resolved = isDeployBadgeSource(source) ? null : markdownImageSource(source, options);
    return resolved ? `<img src="${escapeHtml(resolved)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">` : alt ? `<span class="ssr-image-alt">${escapeHtml(alt)}</span>` : '';
  };

  const anchor = (target: string, inner: string): string => {
    const resolved = href(target);
    if (!resolved) return inner;
    return resolved.external ? `<a href="${escapeHtml(resolved.href)}" rel="nofollow ugc noopener">${inner}</a>` : `<a href="${escapeHtml(resolved.href)}">${inner}</a>`;
  };

  const render = (node: Node): string => {
    const inner = () => (node.children ?? []).map(render).join('');
    switch (node.type) {
      case 'root': return inner();
      case 'paragraph': return `<p>${inner()}</p>`;
      case 'heading': {
        const level = Math.min(6, (node.depth ?? 1) + offset);
        const base = slug(plainText(node)) || 'section';
        const seen = slugs.get(base) ?? 0;
        slugs.set(base, seen + 1);
        return `<h${level} id="${escapeHtml(seen ? `${base}-${seen}` : base)}">${inner()}</h${level}>`;
      }
      case 'text': return escapeHtml(node.value ?? '');
      case 'emphasis': return `<em>${inner()}</em>`;
      case 'strong': return `<strong>${inner()}</strong>`;
      case 'delete': return `<del>${inner()}</del>`;
      case 'inlineCode': return `<code>${escapeHtml(node.value ?? '')}</code>`;
      case 'break': return '<br>';
      case 'thematicBreak': return '<hr>';
      case 'blockquote': return `<blockquote>${inner()}</blockquote>`;
      case 'code': {
        const language = /^[\w+-]{1,40}$/.test(node.lang ?? '') ? ` class="language-${node.lang}"` : '';
        return `<pre><code${language}>${escapeHtml(node.value ?? '')}</code></pre>`;
      }
      case 'list': {
        const tag = node.ordered ? 'ol' : 'ul';
        const start = node.ordered && node.start != null && node.start !== 1 ? ` start="${Number(node.start)}"` : '';
        return `<${tag}${start}>${inner()}</${tag}>`;
      }
      case 'listItem': {
        const box = typeof node.checked === 'boolean' ? `<input type="checkbox" disabled${node.checked ? ' checked' : ''} aria-label="${node.checked ? 'Done' : 'Not done'}"> ` : '';
        const children = node.children ?? [];
        const body = children.length === 1 && children[0]!.type === 'paragraph' ? (children[0]!.children ?? []).map(render).join('') : inner();
        return `<li>${box}${body}</li>`;
      }
      case 'link': return anchor(node.url ?? '', inner());
      case 'linkReference': return anchor(links.get(node.identifier ?? '') ?? '', inner());
      case 'image': return image(node.url ?? '', node.alt ?? '');
      case 'imageReference': return image(links.get(node.identifier ?? '') ?? '', node.alt ?? '');
      case 'table': {
        const [head, ...rows] = node.children ?? [];
        const cells = (row: Node | undefined, tag: 'th' | 'td') => (row?.children ?? []).map((cell, index) => {
          const align = node.align?.[index];
          return `<${tag}${align ? ` style="text-align:${align}"` : ''}>${(cell.children ?? []).map(render).join('')}</${tag}>`;
        }).join('');
        return `<div class="ssr-table"><table><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${rows.map(row => `<tr>${cells(row, 'td')}</tr>`).join('')}</tbody></table></div>`;
      }
      case 'footnoteReference': return `<sup>[${escapeHtml(node.identifier ?? '')}]</sup>`;
      case 'footnoteDefinition': return `<div class="ssr-footnote">[${escapeHtml(node.identifier ?? '')}] ${inner()}</div>`;
      default: return '';
    }
  };
  return render(tree);
}
