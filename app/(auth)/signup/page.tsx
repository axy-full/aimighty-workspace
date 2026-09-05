"use client";

/**
 * Sign up, by invitation: an account, and a workspace of your own.
 * The invitation fixes the address; you choose the name, the workspace
 * and the password.
 */
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthCard, Field, Submit, ErrorLine } from "@/components/AuthCard";
import { RequestAccessButton } from "@/components/RequestAccess";

export default function SignupPage() {
  return <Suspense fallback={<AuthCard title="Checking the invitation…"><span /></AuthCard>}><Signup /></Suspense>;
}

function Signup() {
  const router = useRouter();
  const params = useSearchParams();
  const code = params.get("invite") ?? "";
  // No code, no form: decided at first render rather than in an effect.
  const [state, setState] = useState<{ email: string; name: string; open: boolean } | { dead: string } | null>(
    () => (code ? null : { dead: "Sign-up is by invitation. Ask management for one." }));
  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    let live = true;
    fetch(`/api/auth/signup?code=${encodeURIComponent(code)}`)
      .then(async (res) => { const j = await res.json().catch(() => ({})); if (!live) return; if (res.ok) { setState({ email: j.email, name: j.name ?? "", open: Boolean(j.open) }); setName(j.name ?? ""); } else setState({ dead: j.error ?? "That invitation isn't valid." }); })
      .catch(() => { if (live) setState({ dead: "Couldn't check the invitation. Try again." }); });
    return () => { live = false; };
  }, [code]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!("email" in (state ?? {}))) return;
    if (password !== confirm) { setErr("Passwords don't match."); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, name, email: (state as { email: string }).email, workspace, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't sign up");
      router.push("/");
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  if (!state) return <AuthCard title="Checking the invitation…"><span /></AuthCard>;
  if ("dead" in state) {
    return (
      <AuthCard title="This invitation won't work" sub={state.dead}>
        <p className="flex items-center justify-between text-[12.5px] text-dim">
          <Link href="/login" className="hover:text-ink">← Sign in instead</Link>
          <RequestAccessButton className="hover:text-ink" label="Contact management" />
        </p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Create your workspace" sub={`For ${state.email}. Your workspace gets its own database, its own keys and its own team; you own it.`}>
      {!state.open && <ErrorLine>Sign-up isn&rsquo;t open on this deployment yet — contact management.</ErrorLine>}
      <form onSubmit={submit}>
        <Field label="Your name"><input className="ctl" required value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Workspace"><input className="ctl" required value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="Your studio, company, or you" /></Field>
        <Field label="Password"><input className="ctl" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Field label="Confirm"><input className="ctl" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
        <Submit busy={busy}>Create the workspace</Submit>
        {err && <ErrorLine>{err}</ErrorLine>}
        <p className="mt-4 text-[12.5px] text-dim">Already have an account? <Link href="/login" className="text-ink">Sign in</Link> — you can be invited onto a workspace from there.</p>
      </form>
    </AuthCard>
  );
}
