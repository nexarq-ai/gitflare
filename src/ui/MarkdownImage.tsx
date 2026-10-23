import { useState } from "react";
import { isDeployBadgeSource, markdownImageSource, type MarkdownImageContext } from "../shared/markdown-images";
import CloudflareDeployButton from "./CloudflareDeployButton";
import "./markdown-image.css";

export { markdownImageSource, type MarkdownImageContext };

type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] };

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
