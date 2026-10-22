import type { AdvisoryAffected, AdvisoryCloseReason, AdvisoryFields, AdvisorySeverity, AdvisoryState, ReleaseAssetUsage } from "../shared/types";

export const ADVISORY_LIST_MAX = 10;
export const ADVISORY_TITLE_MAX = 200;
export const ADVISORY_DESCRIPTION_MAX = 20_000;
export const ADVISORY_COMMENT_MAX = 10_000;

export const SEVERITY_LABELS: Record<AdvisorySeverity, string> = { low: "Low", moderate: "Moderate", high: "High", critical: "Critical" };
export const STATE_LABELS: Record<AdvisoryState, string> = { draft: "Draft", published: "Published", closed: "Closed" };
export const CLOSE_REASON_LABELS: Record<AdvisoryCloseReason, string> = { not_a_vulnerability: "Not a vulnerability", duplicate: "Duplicate", out_of_scope: "Out of scope", withdrawn: "Withdrawn" };

const CVE = /^CVE-\d{4}-\d{4,}$/;
const CWE = /^CWE-\d{1,5}$/;
const CVSS = /^CVSS:(?:3\.[01]|4\.0)\/(?:[A-Z]{1,3}:[A-Z]{1,2})(?:\/[A-Z]{1,3}:[A-Z]{1,2})*$/;

export function validCve(value: string): boolean { return CVE.test(value); }
export function validCvss(value: string): boolean { return CVSS.test(value); }

function splitList(value: string): string[] {
  return value.split(/[,\n]/).map(item => item.trim()).filter(Boolean);
}

export function cweList(value: string): string[] {
  return splitList(value).map(item => /^\d+$/.test(item) ? `CWE-${item}` : item.toUpperCase());
}

export function httpsUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && !!url.hostname; } catch { return false; }
}

export interface AdvisoryDraft {
  title: string;
  description: string;
  severity: AdvisorySeverity | "";
  cvssVector: string;
  cveId: string;
  cweIds: string;
  affected: AdvisoryAffected[];
  references: string[];
  credits: string[];
  releaseId: string;
}

export function emptyAffected(): AdvisoryAffected {
  return { ecosystem: "", package: "", vulnerableVersions: "", patchedVersions: "" };
}

export function draftFrom(fields?: Partial<AdvisoryFields>): AdvisoryDraft {
  return {
    title: fields?.title ?? "",
    description: fields?.description ?? "",
    severity: fields?.severity ?? "",
    cvssVector: fields?.cvssVector ?? "",
    cveId: fields?.cveId ?? "",
    cweIds: (fields?.cweIds ?? []).join(", "),
    affected: fields?.affected?.length ? fields.affected.map(row => ({ ...row })) : [],
    references: [...(fields?.references ?? [])],
    credits: [...(fields?.credits ?? [])],
    releaseId: fields?.releaseId ?? "",
  };
}

export type DraftErrors = Partial<Record<"title" | "description" | "cvssVector" | "cveId" | "cweIds" | "affected" | "references" | "credits", string>>;

export function draftErrors(draft: AdvisoryDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (!draft.title.trim()) errors.title = "Add a title.";
  else if (draft.title.trim().length > ADVISORY_TITLE_MAX) errors.title = `Use at most ${ADVISORY_TITLE_MAX} characters.`;
  if (!draft.description.trim()) errors.description = "Describe the vulnerability.";
  else if (draft.description.length > ADVISORY_DESCRIPTION_MAX) errors.description = `Use at most ${ADVISORY_DESCRIPTION_MAX.toLocaleString()} characters.`;
  if (draft.cvssVector.trim() && !validCvss(draft.cvssVector.trim())) errors.cvssVector = "Use a CVSS 3.1 or 4.0 vector, such as CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H.";
  if (draft.cveId.trim() && !validCve(draft.cveId.trim().toUpperCase())) errors.cveId = "Use the form CVE-2026-12345.";
  const cwes = cweList(draft.cweIds);
  if (cwes.some(item => !CWE.test(item))) errors.cweIds = "Use CWE identifiers such as CWE-79, separated by commas.";
  else if (cwes.length > ADVISORY_LIST_MAX) errors.cweIds = `Add at most ${ADVISORY_LIST_MAX}.`;
  const affected = draft.affected.filter(row => Object.values(row).some(value => value.trim()));
  if (affected.length > ADVISORY_LIST_MAX) errors.affected = `Add at most ${ADVISORY_LIST_MAX} packages.`;
  else if (affected.some(row => !row.ecosystem.trim() || !row.package.trim())) errors.affected = "Each affected package needs an ecosystem and a name.";
  const references = draft.references.map(item => item.trim()).filter(Boolean);
  if (references.length > ADVISORY_LIST_MAX) errors.references = `Add at most ${ADVISORY_LIST_MAX} references.`;
  else if (references.some(item => !httpsUrl(item))) errors.references = "References must be https:// links.";
  const credits = draft.credits.map(item => item.trim()).filter(Boolean);
  if (credits.length > ADVISORY_LIST_MAX) errors.credits = `Add at most ${ADVISORY_LIST_MAX} names.`;
  return errors;
}

export function draftPayload(draft: AdvisoryDraft) {
  return {
    title: draft.title.trim(),
    description: draft.description,
    severity: draft.severity || null,
    cvssVector: draft.cvssVector.trim() || null,
    cveId: draft.cveId.trim().toUpperCase() || null,
    cweIds: cweList(draft.cweIds),
    affected: draft.affected.map(row => ({ ecosystem: row.ecosystem.trim(), package: row.package.trim(), vulnerableVersions: row.vulnerableVersions.trim(), patchedVersions: row.patchedVersions.trim() })).filter(row => row.ecosystem || row.package || row.vulnerableVersions || row.patchedVersions),
    references: draft.references.map(item => item.trim()).filter(Boolean),
    credits: draft.credits.map(item => item.trim()).filter(Boolean),
    releaseId: draft.releaseId || null,
  };
}

export function publishBlockers(fields: Pick<AdvisoryFields, "title" | "description" | "severity">): string[] {
  return [!fields.title.trim() && "a title", !fields.description.trim() && "a description", !fields.severity && "a severity"].filter((item): item is string => !!item);
}

export function byteLabel(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

const ASSET_NAME = /^[^\\/\u0000-\u001f]{1,200}$/;

export function assetProblem(file: { name: string; size: number }, usage: ReleaseAssetUsage, existing: { name: string }[]): string | null {
  if (!usage.available) return "File uploads are not available on this installation.";
  if (!ASSET_NAME.test(file.name) || file.name === "." || file.name === "..") return "Rename the file. Names can't contain slashes or control characters.";
  if (existing.some(asset => asset.name === file.name)) return `${file.name} is already attached. Delete it first to replace it.`;
  if (existing.length >= usage.maxAssetsPerRelease) return `A release holds at most ${usage.maxAssetsPerRelease} files.`;
  if (file.size === 0) return "The file is empty.";
  if (file.size > usage.maxAssetBytes) return `${file.name} is ${byteLabel(file.size)}. The limit is ${byteLabel(usage.maxAssetBytes)} per file.`;
  if (file.size > Math.max(0, usage.limitBytes - usage.usedBytes)) return `Not enough storage left: ${byteLabel(Math.max(0, usage.limitBytes - usage.usedBytes))} of ${byteLabel(usage.limitBytes)} remains.`;
  return null;
}

export function shortHash(sha256: string): string { return sha256.slice(0, 12); }
