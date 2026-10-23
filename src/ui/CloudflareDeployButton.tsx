import { ArrowUpRightIcon } from "@phosphor-icons/react";
import cloudflareIcon from "./assets/cloudflare-icon.svg";
import "./cloudflare-deploy-button.css";

const sourceUrl = "https://github.com/nexarq-ai/gitflare";
const deployUrl = `https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(sourceUrl)}`;

export function isGitflareDeployUrl(href?: string) {
  return href === deployUrl || href === `https://deploy.workers.cloudflare.com/?url=${sourceUrl}`;
}

export default function CloudflareDeployButton({ href = deployUrl, label = "Deploy on Cloudflare" }: { href?: string; label?: string }) {
  return (
    <a className="cloudflare-deploy-button" href={href} target="_blank" rel="noopener noreferrer">
      <span className="cloudflare-deploy-icon"><img src={cloudflareIcon} alt="" width="20" height="20" /></span>
      <span className="cloudflare-deploy-label">{label}</span>
      <ArrowUpRightIcon className="cloudflare-deploy-arrow" size={15} aria-hidden="true" />
    </a>
  );
}
