import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextFiles, MarkdownContent } from '../src/ui/MissionDocuments';

const renderMarkdown = (content: string) => renderToStaticMarkup(createElement(MarkdownContent, { content }));

describe('mission document content', () => {
  it('renders document structure, tables, tasks, and highlighted code', () => {
    const result = renderMarkdown('# Contract\n\n## Scope\n\n- First item\n- [x] Finished\n\n| File | Purpose |\n| --- | --- |\n| ENGINE.md | Runtime |\n\n```javascript\nconst enabled = true;\n```');
    expect(result).toContain('<h1>Contract</h1>');
    expect(result).toContain('<h2>Scope</h2>');
    expect(result).toContain('<li>First item</li>');
    expect(result).toContain('type="checkbox"');
    expect(result).toContain('<table>');
    expect(result).toContain('document-token-keyword');
    expect(result).toContain('document-token-literal');
  });

  it('does not execute raw HTML, unsafe links, or remote image loads', () => {
    const result = renderMarkdown('<script>alert(1)</script>\n\n[unsafe](javascript:alert%281%29)\n\n![System diagram](https://remote.example/tracker.png)\n\n[safe](https://example.com/guide)');
    expect(result).not.toContain('<script');
    expect(result).not.toContain('javascript:');
    expect(result).not.toContain('<img');
    expect(result).not.toContain('remote.example');
    expect(result).toContain('System diagram');
    expect(result).toContain('href="https://example.com/guide"');
    expect(result).toContain('rel="noopener noreferrer"');
  });

  it('resolves relative attachment references without navigating into app routes', () => {
    const documents = [{ name: 'notes/CONTRACT.md', content: '' }, { name: 'notes/GAME DESIGN.md', content: '' }];
    const result = renderToStaticMarkup(createElement(MarkdownContent, { content: '[Game](./GAME%20DESIGN.md) [Missing](./missing.md) [Section](#scope)', documents, currentDocument: 'notes/CONTRACT.md', onDocumentSelect: () => {} }));
    expect(result).toContain('class="mission-document-link"');
    expect(result).toContain('>Game</button>');
    expect(result).not.toContain('href=');
    expect(result).toContain('<span>Missing</span>');
    expect(result).toContain('<span>Section</span>');
  });

  it('preserves the entire attached document beyond the old preview boundary', () => {
    const content = '# Contract\n\n' + 'Document body. '.repeat(300) + '\n\n## Final requirement\n\nAll state must survive reload.';
    const result = renderToStaticMarkup(createElement(ContextFiles, { files: [{ name: 'CONTRACT.md', content }] }));
    expect(result).toContain('<h2>Final requirement</h2>');
    expect(result).toContain('All state must survive reload.');
    expect(result).toContain('aria-current="true"');
    expect(result).toContain('View source');
  });

  it('renders non-Markdown files as escaped readable text', () => {
    const result = renderToStaticMarkup(createElement(ContextFiles, { files: [{ name: 'engine.txt', content: '<script>raw text</script>\n# Still text' }] }));
    expect(result).toContain('&lt;script&gt;raw text&lt;/script&gt;');
    expect(result).toContain('# Still text');
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('View source');
  });
});
