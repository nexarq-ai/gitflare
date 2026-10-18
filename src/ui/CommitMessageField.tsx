import { InfoIcon } from "@phosphor-icons/react";
import { COMMIT_MESSAGE_MAX, COMMIT_SUBJECT_MAX } from "../shared/commit-message";

export type CommitDraft = { subject: string; body: string };

export default function CommitMessageField({ draft, branch, problem, onChange }: { draft: CommitDraft; branch: string; problem: string | null; onChange: (draft: CommitDraft) => void }) {
  return (
    <div className="form-field commit-message-field">
      <label htmlFor="commit-subject">Commit message</label>
      <input id="commit-subject" value={draft.subject} maxLength={COMMIT_SUBJECT_MAX} placeholder="Subject" autoComplete="off" onChange={(event) => onChange({ ...draft, subject: event.target.value })} />
      <textarea aria-label="Commit message body" rows={4} value={draft.body} maxLength={COMMIT_MESSAGE_MAX} placeholder="Description (optional)" onChange={(event) => onChange({ ...draft, body: event.target.value })} />
      <small className="commit-message-tip"><InfoIcon size={13} aria-hidden /> Used for the commit that lands on <code>{branch}</code>.</small>
      {problem && <div className="form-error" role="alert">{problem}</div>}
    </div>
  );
}
