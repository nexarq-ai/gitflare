import { useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import AuthScreen, { type AuthConfig } from "./AuthScreen";
import { request, RequestError, selectWorkspace } from "./api";
import { navigate as goTo } from "./router";
import { useDarkOnlySurface } from "./ThemeToggle";
import { BrandMark } from "./BrandMark";

type Props = { route: string; config: AuthConfig; state: "checking" | "required" | "configuration" | "unavailable" | "authenticated"; error: string; onRetry: () => Promise<void>; onSignedIn: () => Promise<void>; onFlowChange: (active: boolean) => void };
export default function InvitationScreen({route,config,state,error,onRetry,onSignedIn,onFlowChange}: Props) {
  useDarkOnlySurface();
  const params = new URLSearchParams(route.split("?")[1]); const token = params.get("token") ?? "";
  const [busy,setBusy] = useState(false); const [failure,setFailure] = useState("");
  if (!/^[a-f0-9]{64}$/i.test(token)) return <main className="auth-screen"><section className="auth-card"><h1>Invitation link is incomplete</h1><p>Ask the workspace owner for a new invitation link.</p><a href="/signin">Sign in</a></section></main>;
  if (state !== "authenticated") return <AuthScreen key={params.get("mode") ?? "signin"} mode={params.get("mode") === "signup" ? "signup" : "signin"} config={config} state={state} error={error} onRetry={onRetry} onSignedIn={onSignedIn} onFlowChange={onFlowChange} invitationToken={token}/>;
  async function accept() {
    setBusy(true); setFailure(""); onFlowChange(true);
    try { const result = await request<{workspaceId:string}>("/api/access/accept-invite",{token}); selectWorkspace(result.workspaceId); goTo("overview"); await onSignedIn(); }
    catch (caught) { setFailure(invitationFailure(caught)); }
    finally { setBusy(false); onFlowChange(false); }
  }
  return <main className="auth-screen"><div className="auth-content"><a className="auth-brand" href="/overview"><BrandMark size={32}/></a><section className="auth-card"><h1>Join the invited workspace</h1><p className="auth-description">Accept with the account the invitation was sent to. The link works once and expires 24 hours after it was sent.</p>{failure && <p className="form-error" role="alert">{failure}</p>}<Button variant="primary" loading={busy} onClick={() => void accept()}>Accept invitation</Button><p><a href="/overview">Return to your workspace</a></p></section></div></main>;
}

export function invitationFailure(caught: unknown): string {
  if (caught instanceof RequestError && caught.code === "INVITATION_IDENTITY") return "This invitation is for a different email address. Sign out and sign in with that account.";
  if (caught instanceof RequestError && caught.code === "INVITATION_EXPIRED") return "This invitation has expired or was already used. Ask the workspace Owner for a new one.";
  if (caught instanceof RequestError && caught.code === "ALREADY_MEMBER") return "You already belong to this workspace.";
  return caught instanceof Error ? caught.message : "The invitation could not be accepted.";
}
