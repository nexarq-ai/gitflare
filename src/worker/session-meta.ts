import type { SessionMeta } from './security';

const BROWSERS: [RegExp, string][] = [[/Edg\//, 'Edge'], [/OPR\/|Opera/, 'Opera'], [/Firefox\//, 'Firefox'], [/Chrome\//, 'Chrome'], [/Safari\//, 'Safari']];
const SYSTEMS: [RegExp, string][] = [[/iPhone|iPad|iPod/, 'iOS'], [/Android/, 'Android'], [/Mac OS X|Macintosh/, 'macOS'], [/Windows/, 'Windows'], [/CrOS/, 'ChromeOS'], [/Linux/, 'Linux']];

export function describeDevice(userAgent: string | null): string | undefined {
  if (!userAgent) return undefined;
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (!browser && !system) return undefined;
  return browser && system ? `${browser} on ${system}` : browser ?? system;
}

export function requestSessionMeta(request: Request): SessionMeta {
  const country = (request as Request & { cf?: { country?: unknown } }).cf?.country;
  const device = describeDevice(request.headers.get('User-Agent'));
  return { ...(device ? { device } : {}), ...(typeof country === 'string' && /^[A-Z]{2}$/.test(country) ? { country } : {}) };
}
