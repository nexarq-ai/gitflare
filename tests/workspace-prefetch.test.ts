import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../src/ui/App.tsx', import.meta.url), 'utf8');

describe('workspace page prefetch', () => {
  it('starts only after the route content inside the main Suspense boundary has rendered', () => {
    const main = app.slice(app.indexOf('<main className="page-content"'), app.indexOf('</main>'));
    const boundary = main.slice(main.indexOf('<Suspense fallback={<RouteProgress />}>'), main.lastIndexOf('</Suspense>'));
    expect(boundary).toContain('<PrefetchWorkspacePages />');
    expect(app.match(/for \(const load of workspacePages\)/g)).toHaveLength(1);
  });

  it('waits for an idle period before fetching other pages', () => {
    const component = app.slice(app.indexOf('function PrefetchWorkspacePages()'), app.indexOf('function ReconnectingNotice()'));
    expect(component).toContain('requestIdleCallback(prefetch)');
    expect(component).toContain('cancelIdleCallback');
  });
});
