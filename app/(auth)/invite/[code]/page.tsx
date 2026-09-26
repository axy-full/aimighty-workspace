"use client";

/**
 * Accepting a workspace invitation. A new person chooses a password and
 * gets an account; someone who already has one joins while signed in as
 * it — the invitation names the address, and only that address can take it.
 */
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthCard, Field, Submit, ErrorLine } from "@/components/AuthCard";

type Info = { workspace: string; email: string; name: string; role: string; hasAccount: boolean; signedInAsInvitee: boolean };

export default function InvitePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const router = useRouter();
  const [info, setInfo] = useState<Info | { dead: string } | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/auth/accept?code=${encodeURIComponent(code)}`)
      .then(async (res) => { const j = await res.json().catch(() => ({})); if (live) setInfo(res.ok ? j : { dead: j.error ?? "That invite link isn't valid." }); })
      .catch(() => { if (live) setInfo({ dead: "Couldn't check the invitation. Try again." }); });
    return () => { live = false; };
  }, [code]);

  async function accept(withPassword: boolean) {
    if (withPassword && password !== confirm) { setErr("Passwords don't match."); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/auth/accept", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withPassword ? { code, password, accept: agreed } : { code }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not accept the invite");
      router.push("/");
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  if (!info) return <AuthCard title="Checking the invitation…"><span /></AuthCard>;
  if ("dead" in info) return <AuthCard title="This invitation won't work" sub={info.dead}><Link href="/login" className="hdr-mono-link">← SIGN IN</Link></AuthCard>;

  if (info.hasAccount) {
    return (
      <AuthCard title={`Join ${info.workspace}`} sub={info.signedInAsInvitee ? `You've been invited as ${info.role === "admin" ? "an admin" : "a member"}.` : `This invitation is for ${info.email}, which already has an account. Sign in as it, then open this link again.`}>
        {info.signedInAsInvitee
          ? <button type="button" className="btn-primary !h-[46px] w-full justify-center !text-[14px]" onClick={() => accept(false)} disabled={busy}>{busy ? "…" : `Join ${info.workspace}`}</button>
          : <Link href={`/login?next=${encodeURIComponent(`/invite/${code}`)}`} className="btn-primary !h-[46px] w-full justify-center !text-[14px]">Sign in as {info.email}</Link>}
        {err && <ErrorLine>{err}</ErrorLine>}
      </AuthCard>
    );
  }
  return (
    <AuthCard title={`Join ${info.workspace}`} sub={`You've been invited to ${info.workspace} as ${info.role === "admin" ? "an admin" : "a member"}. Choose a password for ${info.email} and you're in.`}>
      <form onSubmit={(e) => { e.preventDefault(); accept(true); }}>
        <Field label="Password"><input className="ctl" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /></Field>
        <Field label="Confirm"><input className="ctl" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
        <label className="mt-3 flex min-h-[44px] items-start gap-2 text-[13px] leading-relaxed text-dim">
          <input className="mt-1" type="checkbox" required checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>
            I agree to the <Link className="text-ink underline" href="/terms" target="_blank">terms</Link> and{" "}
            <Link className="text-ink underline" href="/policy" target="_blank">content policy</Link>. Read the{" "}
            <Link className="text-ink underline" href="/privacy" target="_blank">privacy notice</Link>.
          </span>
        </label>
        <Submit busy={busy}>Join the workspace</Submit>
        {err && <ErrorLine>{err}</ErrorLine>}
      </form>
    </AuthCard>
  );
}
