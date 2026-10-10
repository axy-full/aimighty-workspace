"use client";
import { useId, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { Dialog } from "../ui";
import { COMPANY_SIZES, ROLES, cleanCode, emailPath, inviteKind, joinTitle, loginPath, requestBody, requestProblem, type InviteKind, type RequestFields } from "./join-model";
import type { JoinState } from "./JoinProvider";
import { GOOGLE_SIGN_IN } from "./google";
import "./join.css";

/**
 * The join sheet (docs/redesign/inventory.md § 8.3, § 8.5; prototype L59–L69, L34–L42): Particl is invite-only.
 * Desktop: a 720 px dialog with two equal columns, "I have an invite" and "Request access". Phone: the same as one
 * column in a bottom sheet, with Continue with email beside Continue with Google (FIX 4) and the whole request form.
 *
 * It signs nobody in itself: a code goes to today's pages (/invite/‹code› for a team invite, /signup?invite=‹code› for
 * a new workspace), which verify exactly what they verify today, and a request goes to today's POST /api/access-request.
 * On the overlay stack's join layer: Esc, × or the scrim close it and keep everything typed.
 */
export function JoinSheet({ state, setState, invite, compact, back, onClose }: {
  state: JoinState;
  setState: Dispatch<SetStateAction<JoinState>>;
  invite: InviteKind | null;
  compact: boolean;
  back: string;
  onClose: () => void;
}) {
  const title = joinTitle(state.reason, state.detail);
  const head = (
    <div className="v12-join-head">
      <span className="v12-join-eyebrow">Particl is invite-only</span>
      <h2 className="v12-join-title" data-testid="v12-join-title">{title}</h2>
      {state.prompt.trim() ? <span className="v12-join-prompt" data-testid="v12-join-prompt">“{state.prompt.trim()}”</span> : null}
    </div>
  );
  return (
    <Dialog open={state.open} onClose={onClose} label={title} head={head} layer="join" scrim="join" variant={compact ? "sheet" : "dialog"}
      width={compact ? undefined : 720} closeTip="Close" closeLine="Your text stays in the bar." className="v12-join" testId="v12-join">
      {state.requested ? (
        <Requested onDone={onClose} />
      ) : (
        <div className="v12-join-paths" data-compact={compact ? "" : undefined}>
          <InvitePath state={state} setState={setState} invite={invite} />
          <RequestPath state={state} setState={setState} primary={!(invite?.kind === "team" && invite.code === cleanCode(state.code))} />
        </div>
      )}
      <div className="v12-join-foot">
        <span>Your work stays private to your workspace.</span>
        <a href={loginPath(back)} className="v12-join-login" data-testid="v12-join-login">Already a member? Log in</a>
      </div>
    </Dialog>
  );
}

function Requested({ onDone }: { onDone: () => void }) {
  return (
    <div className="v12-join-done" role="status" data-testid="v12-join-requested">
      <span className="v12-join-done-title"><span className="v12-join-done-dot" aria-hidden="true" />You’re on the list.</span>
      <span className="v12-join-done-line">We’ll email you when your invite is ready; your prompt is saved for when you’re in.</span>
      <button type="button" className="v12-join-btn" onClick={onDone} data-testid="v12-join-keep-looking">Keep looking around</button>
    </div>
  );
}

/** Reads a code with today's two public routes: a team invite, else a new-workspace invite. */
async function readCode(code: string): Promise<InviteKind> {
  const read = async (url: string) => {
    const res = await fetch(url, { cache: "no-store" });
    return { status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  };
  const team = await read(`/api/auth/accept?code=${encodeURIComponent(code)}`);
  if (team.status === 200 || team.status === 409 || team.status === 410) return inviteKind(code, team, null);
  return inviteKind(code, team, await read(`/api/auth/signup?code=${encodeURIComponent(code)}`));
}

function InvitePath({ state, setState, invite }: { state: JoinState; setState: Dispatch<SetStateAction<JoinState>>; invite: InviteKind | null }) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const code = cleanCode(state.code);
  const team = invite?.kind === "team" && invite.code === code;

  const withEmail = async () => {
    if (busy) return;
    if (!code) { setProblem("Enter your invite code first."); return; }
    setBusy(true);
    setProblem("");
    try {
      const kind = invite && invite.code === code && invite.kind !== "invalid" ? invite : await readCode(code);
      const to = emailPath(kind);
      if (to) { window.location.assign(to); return; }
      setProblem(kind.kind === "expired" ? "This invite has expired or been used. Request access instead." : "That invite code isn’t valid. Check it, or request access.");
    } catch {
      setProblem("The code could not be checked. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="v12-join-path" aria-labelledby={`${id}-invite`} data-testid="v12-join-invite">
      <h3 className="v12-join-path-title" id={`${id}-invite`}>I have an invite</h3>
      {team ? <p className="v12-join-line" data-testid="v12-join-team">{invite.workspace ? `Join ${invite.workspace}’s workspace.` : "Join the workspace you were invited to."}</p> : null}
      <input className="v12-join-input v12-join-code" aria-label="Invite code" placeholder="Invite code" value={state.code} autoComplete="one-time-code" spellCheck={false}
        onChange={(e) => { setProblem(""); const value = e.target.value; setState((now) => ({ ...now, code: value })); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void withEmail(); } }} data-testid="v12-join-code" />
      <div className="v12-join-stack">
        {/* With a team invite the next step is filled: Google's in the prototype; Continue with email until Google sign-in exists (./google.ts). */}
        <button type="button" className={team && GOOGLE_SIGN_IN.ready ? "v12-join-btn v12-join-primary" : "v12-join-btn"} onClick={() => setProblem(GOOGLE_SIGN_IN.ready ? "" : GOOGLE_SIGN_IN.notYet)} data-testid="v12-join-google">
          Continue with Google
        </button>
        <button type="button" className={team && !GOOGLE_SIGN_IN.ready ? "v12-join-btn v12-join-primary" : "v12-join-btn"} onClick={() => void withEmail()} disabled={busy} aria-busy={busy || undefined} data-testid="v12-join-email">
          {busy ? "Checking the code…" : "Continue with email"}
        </button>
      </div>
      {problem ? <p className="v12-join-problem" role="alert" data-testid="v12-join-invite-problem">{problem}</p> : null}
    </section>
  );
}

/** `primary`: the sheet's one filled button, unless a team invite makes Continue with Google the next step. */
function RequestPath({ state, setState, primary }: { state: JoinState; setState: Dispatch<SetStateAction<JoinState>>; primary: boolean }) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  /* The access route's honeypot: off-screen, out of the tab order, filled only by a bot. */
  const [trap, setTrap] = useState("");
  const f = state.fields;
  const set = (key: keyof RequestFields) => (value: string) => { setProblem(""); setState((now) => ({ ...now, fields: { ...now.fields, [key]: value } })); };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const missing = requestProblem(f);
    if (missing) { setProblem(missing); return; }
    setBusy(true);
    setProblem("");
    try {
      const res = await fetch("/api/access-request", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...requestBody(f, state.reason), ...(trap ? { company: trap } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "That didn’t send. Try again in a moment.");
      setState((now) => ({ ...now, requested: true }));
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="v12-join-path" aria-labelledby={`${id}-request`} onSubmit={send} data-testid="v12-join-request">
      <h3 className="v12-join-path-title" id={`${id}-request`}>Request access</h3>
      <div className="v12-join-grid">
        <input className="v12-join-input" aria-label="Name" placeholder="Name" autoComplete="name" maxLength={120} value={f.name} onChange={(e) => set("name")(e.target.value)} data-testid="v12-join-name" />
        <input className="v12-join-input" aria-label="Work email" placeholder="Work email" type="email" autoComplete="email" maxLength={200} value={f.email} onChange={(e) => set("email")(e.target.value)} data-testid="v12-join-work-email" />
        <input className="v12-join-input" aria-label="Company" placeholder="Company" autoComplete="organization" maxLength={120} value={f.company} onChange={(e) => set("company")(e.target.value)} data-testid="v12-join-company" />
        <select className="v12-join-input" aria-label="Role" value={f.role} onChange={(e) => set("role")(e.target.value)} data-testid="v12-join-role">
          <option value="">Role</option>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select className="v12-join-input v12-join-wide" aria-label="Company size (optional)" value={f.size} onChange={(e) => set("size")(e.target.value)} data-testid="v12-join-size">
          <option value="">Company size (optional)</option>
          {COMPANY_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <textarea className="v12-join-input v12-join-want" aria-label="What do you want to make? (optional)" placeholder="What do you want to make? (optional)" maxLength={900}
        value={f.want} onChange={(e) => set("want")(e.target.value)} data-testid="v12-join-want" />
      <input tabIndex={-1} autoComplete="off" aria-hidden="true" className="v12-join-trap" value={trap} onChange={(e) => setTrap(e.target.value)} />
      {problem ? <p className="v12-join-problem" role="alert" data-testid="v12-join-request-problem">{problem}</p> : null}
      <button type="submit" className={primary ? "v12-join-btn v12-join-primary" : "v12-join-btn"} disabled={busy} aria-busy={busy || undefined} data-testid="v12-join-send">
        {busy ? "Sending…" : "Request access"}
      </button>
    </form>
  );
}
