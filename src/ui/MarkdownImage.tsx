import { useState } from "react";
import { isDeployBadgeSource, rawImagePath, rawImageType, resolveRepositoryPath } from "../shared/markdown-images";
import CloudflareDeployButton from "./CloudflareDeployButton";
import "./markdown-image.css";

export interface MarkdownImageContext {
  images?: Record<string, string>;
  repository?: { handle: string; name: string; commitSha?: string; path: string };
}

type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] };

const COMMIT_SHA = /^[a-f0-9]{40}$/;

export function markdownImageSource(src: string | undefined, context: MarkdownImageContext): string | null {
  if (!src) return null;
  const proxied = context.images && Object.hasOwn(context.images, src) ? context.images[src] : undefined;
  if (proxied?.startsWith("/-/img?")) return proxied;
  const repository = context.repository;
  if (!repository?.commitSha || !COMMIT_SHA.test(repository.commitSha)) return null;
  const path = resolveRepositoryPath(src, repository.path);
  return path && rawImageType(path) ? rawImagePath(repository.handle, repository.name, repository.commitSha, path) : null;
}

export function MarkdownImage({ src, alt, context, fallbackClassName }: { src?: string; alt?: string; context: MarkdownImageContext; fallbackClassName?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const resolved = isDeployBadgeSource(src) ? null : markdownImageSource(src, context);
  if (!resolved || failed === resolved) return <span className={fallbackClassName}>{alt || "Image"}</span>;
  return <img className="markdown-image" src={resolved} alt={alt ?? ""} loading="lazy" decoding="async" onError={() => setFailed(resolved)} />;
}

export function isDeployBadgeLink(node: unknown): boolean {
  const children = ((node as HastNode | undefined)?.children ?? []).filter(child => !(child.type === "text" && !child.value?.trim()));
  const only = children.length === 1 ? children[0]! : null;
  return !!only && only.type === "element" && only.tagName === "img" && isDeployBadgeSource(typeof only.properties?.src === "string" ? only.properties.src : "");
}

export function DeployBadgeLink({ href }: { href: string }) {
  return <CloudflareDeployButton href={href} label="Deploy to Cloudflare" />;
}
