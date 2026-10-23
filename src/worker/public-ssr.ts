import type { AppEnv } from './env';
export interface ServerPage { status: number; location?: string; title?: string; description?: string; head: string; body: string; seed?: string }
export type ServerTarget = never;
export function serverRenderedTarget(_request: Request, _env: AppEnv): ServerTarget | null { return null; }
export interface ServerRender { status: Promise<{ status: number; location?: string } | null>; page: Promise<ServerPage | null> }
export function serverPage(_request: Request, _env: AppEnv, _ctx: unknown, _target: ServerTarget, _produce: (request: Request, env: AppEnv) => Promise<Response>): ServerRender { return { status: Promise.resolve(null), page: Promise.resolve(null) }; }
