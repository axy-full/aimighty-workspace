"use client";
import { Suspense, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { TRAIL } from "@/components/ui/Mark";
import { RequestAccessForm, sentLine, inviteCredits } from "@/components/graphite/guest/RequestAccess";
import { billingPath, readAnswer, signupSignInPath } from "@/lib/authPages";
import { decodeGuestBrief, guestBriefRaw, subscribeGuestBrief } from "@/lib/guest/brief";
import { makeFirstBoardFromGuestBrief } from "@/lib/guest/first-board";
import "@/components/graphite/shell.css";
import "@/components/graphite/guest/guest.css";

/**
 * Sign-up on Graphite (lead decisions 36, 39 and 41), drawn as the master's sign-up sheet (design README § 3.7,
 * frames 3a and 3b) on a page of its own; app/graphite.css tokens only.
 *
 * - With an invitation link (`?invite=`): the invitation fills the email (and the name when it has one); the brief
 *   kept from guest Home is shown; the form asks only for what is missing — the name if the invitation has none,
 *   the workspace's name, a password, and the terms.
 * - Without one, while sign-up is by invitation (the server says `inviteOnly`): Request access.
 * - Without one, while the owner has opened sign-up: today's self-serve form.
 * - A verification link while sign-up is closed is refused by the server; the page offers Request access instead.
 *
 * Sign-in behaviour is unchanged: the same routes, fields and redirects as before; only the layout and the pre-fill.
 */
type SignupAvailability = {
  email?: string;
  name?: string;
  open: boolean;
  /** Sign-up is by invitation link only (the platform owner's /admin setting, lead decision 36). */
  inviteOnly?: boolean;
  reason?: string;
  error?: string;
};
class InviteOnly extends Error {}
const validPlan = (value: string | null) =>
  ["studio", "agency", "production"].includes(value || "") ? value! : "studio";

export default function SignupPage() {
  return (
    <Suspense fallback={<Page title="Create your account"><p className="gx-su-sub" role="status">Loading…</p></Page>}>
      <Signup />
    </Suspense>
  );
}

/** The page's frame: the particl mark, then the sheet's card, centred. */
function Page({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div className="gx gx-signup-page" data-testid="signup-page">
      <main className="gx-su gx-su--page" aria-labelledby="gx-signup-title">
        <Link href="/" className="gx-su-brand" aria-label="particl">
          <svg width="30" height="14" viewBox="30 68 140 64" fill="currentColor" aria-hidden="true">
            {TRAIL.map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r} />)}
          </svg>
          <span>particl</span>
        </Link>
        <div>
          <p className="gx-su-eyebrow">Sign up</p>
          <h1 className="gx-su-title" id="gx-signup-title">{title}</h1>
          {sub ? <p className="gx-su-sub">{sub}</p> : null}
        </div>
        {children}
      </main>
    </div>
  );
}

function Signup() {
  const router = useRouter(),
    params = useSearchParams(),
    code = params.get("invite") || "",
    verify = params.get("verify") || "";
  const plan = validPlan(params.get("plan")),
    cadence = params.get("cadence") === "annual" ? "annual" : "monthly";
  const login = signupSignInPath(code, plan, cadence);
  const [available, setAvailable] = useState<SignupAvailability | null>(null),
    [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [workspace, setWorkspace] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [accept, setAccept] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [refused, setRefused] = useState(false),
    [requested, setRequested] = useState<string | null>(null),
    [sent, setSent] = useState(false),
    [notice, setNotice] = useState(""),
    [needsSignIn, setNeedsSignIn] = useState(false);
  /* What this person typed on guest Home, kept in this browser: it becomes their first board (lead decision 39). */
  const keptBrief = decodeGuestBrief(useSyncExternalStore(subscribeGuestBrief, guestBriefRaw, () => null))?.text.trim() ?? "";
  const verification = useRef<{ token: string; promise: Promise<Record<string, unknown>> } | null>(null);

  useEffect(() => {
    let active = true;
    if (verify) {
      if (verification.current?.token !== verify)
        verification.current = {
          token: verify,
          promise: fetch("/api/auth/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: verify }),
          }).then(async (response) => {
            const { data, problem } = await readAnswer(response, "This verification link could not be used.");
            if (data.inviteOnly === true) throw new InviteOnly(problem ?? "");
            if (problem) throw new Error(problem);
            return data;
          }),
        };
      verification.current.promise
        .then(async (data) => {
          if (!active) return;
          if (data.workspace) await makeFirstBoardFromGuestBrief();
          const destination =
            typeof data.next === "string" && data.next.startsWith("/billing")
              ? data.next
              : billingPath(validPlan(typeof data.planId === "string" ? data.planId : null), data.cadence === "annual" ? "annual" : "monthly");
          router.replace(destination);
          router.refresh();
        })
        .catch((e) => {
          if (!active) return;
          if (e instanceof InviteOnly) setRefused(true);
          else setError(e.message);
        });
      return () => {
        active = false;
      };
    }
    const controller = new AbortController();
    fetch("/api/auth/signup" + (code ? "?code=" + encodeURIComponent(code) : ""), { signal: controller.signal })
      .then(async (response) => {
        const answer = await readAnswer(response, "Sign-up is unavailable.");
        if (answer.problem) throw new Error(answer.problem);
        const data = answer.data as SignupAvailability;
        if (active) {
          setAvailable(data);
          if (data.name) setName(data.name);
          if (data.email) setEmail(data.email);
        }
      })
      .catch((e) => {
        if (active && !controller.signal.aborted) setError(e.message);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [code, verify, router]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!available?.open || busy) return;
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    setNeedsSignIn(false);
    try {
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(code ? { code } : {}), name, email, workspace, password, accept, planId: plan, cadence }),
      });
      const { data, problem } = await readAnswer(response, "Your account could not be created.");
      if (data.inviteOnly === true) { setRefused(true); return; }
      if (problem) {
        setNeedsSignIn(data.needsSignIn === true);
        throw new Error(problem);
      }
      if (data.verificationRequired) {
        setSent(true);
        setNotice(typeof data.message === "string" && data.message ? data.message : "Open the verification link in your email to continue.");
        setPassword("");
        setConfirm("");
      } else {
        if (data.workspace) await makeFirstBoardFromGuestBrief();
        router.push(typeof data.next === "string" && data.next.startsWith("/") && !data.next.startsWith("//") ? data.next : "/workbench");
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach Particl. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/signup/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const { data, problem } = await readAnswer(response, "The verification email could not be sent.");
      if (data.inviteOnly === true) { setRefused(true); return; }
      if (problem) throw new Error(problem);
      setNotice(typeof data.message === "string" && data.message ? data.message : "If a verification is pending for this address, a new email is on its way.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  const signIn = (
    <div className="gx-su-foot">
      <span>Already have an account?</span>
      <Link href={login} className="gx-su-link" data-testid="signup-signin">Sign in</Link>
    </div>
  );
  const kept = keptBrief ? (
    <div className="gx-su-field" data-testid="signup-kept-brief">
      <span className="gx-su-label">Your brief · kept for your first board</span>
      <p className="gx-su-brief"><span>{keptBrief}</span></p>
    </div>
  ) : null;

  /* Invitation-only, with no link (or a self-serve verification after sign-up closed): ask for access instead. */
  if (refused || (!code && !verify && available?.inviteOnly)) {
    if (requested)
      return (
        <Page title="Request sent" sub={`We’ll email a link to ${requested}.`}>
          <p className="gx-su-note" data-testid="signup-sent">{sentLine(inviteCredits(null))}</p>
          {signIn}
        </Page>
      );
    return (
      <Page title="Particl is invite-only for now." sub="Sign-up needs an invitation link. Ask for access and we’ll send you one.">
        <div data-testid="signup-invite-only" className="gx-su-form">
          {kept}
          <RequestAccessForm brief={keptBrief} source="From the sign-up page" onSent={setRequested} />
        </div>
        {signIn}
      </Page>
    );
  }

  if (verify)
    return (
      <Page title={error ? "Check your verification link" : "Verifying your email"} sub={error || "Your account will open as soon as verification completes."}>
        {error ? (
          <div className="gx-su-foot">
            <Link href={`/signup?plan=${plan}&cadence=${cadence}`} className="gx-su-link">Return to sign up</Link>
            <Link href={login} className="gx-su-link">Sign in</Link>
          </div>
        ) : null}
      </Page>
    );

  if (sent)
    return (
      <Page title="Check your email" sub={`We sent a verification link to ${email}.`}>
        <p role="status" className="gx-su-note">{notice}</p>
        <p className="gx-su-note">Your {plan} plan choice and {cadence} billing are saved. You will review checkout after verification. No payment has been taken.</p>
        {error ? <p className="gx-su-problem" role="alert">{error}</p> : null}
        <button type="button" className="gx-hbtn gx-su-second" disabled={busy} onClick={() => void resend()}>{busy ? "Sending…" : "Resend verification email"}</button>
        {signIn}
      </Page>
    );

  /* What the invitation already says is shown, not asked for again. */
  const knownName = Boolean(code && available?.name);
  return (
    <Page title={code ? "Create your account" : "Create your studio workspace"}
      sub={code ? "You have an invitation link. Name your workspace and choose a password." : "Start with your account. Verify your email, then review your plan and payment."}>
      {!code ? (
        <p className="gx-su-note" data-testid="signup-plan">
          <strong>{plan.charAt(0).toUpperCase() + plan.slice(1)}</strong> · {cadence === "annual" ? "Annual billing · 20% discount" : "Monthly billing"} · <Link href="/pricing" className="gx-su-link">Compare plans</Link>
        </p>
      ) : null}
      {code ? kept : null}
      {!available && !error ? <p role="status" className="gx-su-sub">Checking your invitation…</p> : null}
      {available && !available.open ? (
        <p role="status" className="gx-su-note">{available.reason || "New accounts are not available yet. Please return when account registration opens."}</p>
      ) : null}
      <form className="gx-su-form" onSubmit={submit}>
        {knownName ? null : (
          <label className="gx-su-field">
            <span className="gx-su-label">Your name</span>
            <input className="gx-su-input" required autoComplete="name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} data-testid="signup-name" />
          </label>
        )}
        <label className="gx-su-field">
          <span className="gx-su-label">{code ? "Email" : "Work email"}</span>
          <input className="gx-su-input" type="email" required autoComplete="email" value={email} readOnly={Boolean(code)} onChange={(e) => setEmail(e.target.value)} data-testid="signup-email" />
        </label>
        <label className="gx-su-field">
          <span className="gx-su-label">Workspace name</span>
          <input className="gx-su-input" required maxLength={100} value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="Your studio or production house" data-testid="signup-workspace" />
        </label>
        <label className="gx-su-field">
          <span className="gx-su-label">Password</span>
          <input className="gx-su-input" type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="signup-password" />
        </label>
        <label className="gx-su-field">
          <span className="gx-su-label">Confirm password</span>
          <input className="gx-su-input" type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="signup-confirm" />
        </label>
        <label className="gx-su-check">
          <input type="checkbox" required checked={accept} onChange={(e) => setAccept(e.target.checked)} data-testid="signup-terms" />
          <span>I agree to the terms and the content policy, and I have read the privacy notice.</span>
        </label>
        {/* The three documents as their own targets, not words inside the box's label. */}
        <div className="gx-su-docs">
          <Link className="gx-su-link" href="/terms" target="_blank">Terms</Link>
          <Link className="gx-su-link" href="/policy" target="_blank">Content policy</Link>
          <Link className="gx-su-link" href="/privacy" target="_blank">Privacy notice</Link>
        </div>
        <button type="submit" className="gx-primary gx-su-go" disabled={!available?.open || busy} aria-busy={busy || undefined} data-testid="signup-submit">
          {busy ? "Creating…" : code ? "Create account" : "Create account and verify email"}
        </button>
        {error ? <p className="gx-su-problem" role="alert">{error}</p> : null}
        {needsSignIn ? (
          <p className="gx-su-note"><Link href={login} className="gx-su-link">{code ? "Sign in to accept this invitation" : "Sign in to continue with this plan"}</Link></p>
        ) : null}
      </form>
      {code ? <p className="gx-su-note">{inviteCredits(null)} Nothing is spent without your approval.</p> : null}
      {signIn}
    </Page>
  );
}
