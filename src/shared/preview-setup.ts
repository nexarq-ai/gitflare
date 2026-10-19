export const PREVIEW_SETUP_CODES = [
  'PREVIEW_NOT_CONFIGURED',
  'PREVIEW_ORIGIN_INVALID',
  'PREVIEWS_MISCONFIGURED',
  'PREVIEWS_INSTALLATION_UNAVAILABLE',
  'PREVIEWS_NOT_CONNECTED',
  'PREVIEWS_PERMISSION_MISSING',
  'PREVIEWS_ACCESS_PERMISSION_MISSING',
  'PREVIEWS_CONNECTION_REFUSED',
] as const;
export type PreviewSetupCode = typeof PREVIEW_SETUP_CODES[number];

export function isPreviewSetupCode(value: unknown): value is PreviewSetupCode {
  return typeof value === 'string' && (PREVIEW_SETUP_CODES as readonly string[]).includes(value);
}

export interface PreviewSetupViewer { installationAdmin: boolean; owner: boolean }
export interface PreviewSetupFix { line: string; tip: string; action?: { label: string; href: string }; ask?: string }

const INSTALLATION: Record<Extract<PreviewSetupCode, 'PREVIEW_NOT_CONFIGURED' | 'PREVIEW_ORIGIN_INVALID' | 'PREVIEWS_MISCONFIGURED' | 'PREVIEWS_INSTALLATION_UNAVAILABLE'>, [string, string]> = {
  PREVIEW_NOT_CONFIGURED: ['Previews aren’t set up on this installation.', 'The preview origin, Sandbox or Workflow binding is missing. An installation admin sets these up once for everyone.'],
  PREVIEW_ORIGIN_INVALID: ['The preview origin is invalid.', 'Previews need their own HTTPS origin (PREVIEW_ORIGIN), separate from the app’s origin.'],
  PREVIEWS_MISCONFIGURED: ['The installation previews Worker is misconfigured.', 'PREVIEWS_ACCOUNT_ID or PREVIEWS_WORKER_NAME is invalid or too long.'],
  PREVIEWS_INSTALLATION_UNAVAILABLE: ['The installation’s previews connection isn’t working.', 'Repositories without their own Cloudflare connection preview through the installation. Its token or connection was refused or is missing.'],
};

const WORKSPACE: Record<Exclude<PreviewSetupCode, keyof typeof INSTALLATION>, [string, string, string, string]> = {
  PREVIEWS_NOT_CONNECTED: ['Connect Cloudflare to use Worker Previews.', 'Worker Previews run on your Cloudflare account through the workspace connection.', 'Connect Cloudflare', '/settings/cloudflare'],
  PREVIEWS_PERMISSION_MISSING: ['Cloudflare needs the Previews permission.', 'The Cloudflare connection was not granted workers-scripts.edit, so it cannot create Worker Previews.', 'Grant Previews', '/settings/cloudflare?grant=previews'],
  PREVIEWS_ACCESS_PERMISSION_MISSING: ['Cloudflare needs the Access permission.', 'This repository protects previews with Cloudflare Access, and the connection cannot manage Access applications.', 'Grant Access', '/settings/cloudflare?grant=access'],
  PREVIEWS_CONNECTION_REFUSED: ['Cloudflare refused the connection.', 'The Cloudflare connection was refused for this Worker. Reconnecting refreshes its permissions.', 'Reconnect Cloudflare', '/settings/cloudflare'],
};

export function previewSetupFix(code: PreviewSetupCode, viewer: PreviewSetupViewer): PreviewSetupFix {
  if (code in INSTALLATION) {
    const [line, tip] = INSTALLATION[code as keyof typeof INSTALLATION];
    return viewer.installationAdmin ? { line, tip, action: { label: 'Open installation admin', href: '/admin' } } : { line, tip, ask: 'Ask an installation admin' };
  }
  const [line, tip, label, href] = WORKSPACE[code as keyof typeof WORKSPACE];
  return viewer.owner ? { line, tip, action: { label, href } } : { line, tip, ask: 'Ask a workspace Owner' };
}
