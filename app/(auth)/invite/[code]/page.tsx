"use client";

/**
 * Accepting a workspace invitation. A new person chooses a password and
 * gets an account; someone who already has one joins while signed in as
 * it — the invitation names the address, and only that address can take it.
 */
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthFrame, AuthChecking, Eyebrow, Title, PasswordField, Note, Primary, ErrorLine, Links, AuthLink } from "@/components/auth";

type Info = { workspace: string; email: string; name: string; role: string; hasAccount: boolean; signedInAsInvitee: boolean };

export default function InvitePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const router = useRouter();
  const [info, setInfo] = useState<Info | { dead: string } | null>(null);
  const [password, setPassword] = useState("");
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
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/auth/accept", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withPassword ? { code, password } : { code }),
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

  if (!info) return <AuthChecking what="Checking the invitation" />;
  if ("dead" in info) {
    return (
      <AuthFrame>
        <Eyebrow>Invite</Eyebrow>
        <Title>This invitation won&rsquo;t work</Title>
        <Note>{info.dead}</Note>
        <Links><AuthLink href="/login">← Sign in</AuthLink></Links>
      </AuthFrame>
    );
  }

  const role = info.role === "admin" ? "an admin" : "a member";
  if (info.hasAccount) {
    return (
      <AuthFrame onSubmit={(e) => { e.preventDefault(); if (info.signedInAsInvitee) accept(false); else router.push(`/login?next=${encodeURIComponent(`/invite/${code}`)}`); }}>
        <Eyebrow>Invite</Eyebrow>
        <Title>Join {info.workspace}</Title>
        <Note>{info.signedInAsInvitee
          ? <>You&rsquo;ve been invited as {role}.</>
          : <>This invitation is for {info.email}, which already has an account. Sign in as it, then open this link again.</>}</Note>
        {info.signedInAsInvitee
          ? <Primary busy={busy}>Join {info.workspace}</Primary>
          : <Primary>Sign in as {info.email}</Primary>}
        {err && <ErrorLine>{err}</ErrorLine>}
      </AuthFrame>
    );
  }
  return (
    <AuthFrame onSubmit={(e) => { e.preventDefault(); accept(true); }}>
      <Eyebrow>Invite</Eyebrow>
      <Title>Join {info.workspace}</Title>
      <Note>You&rsquo;ve been invited as {role}. Choose a password for {info.email} and you&rsquo;re in.</Note>
      <PasswordField name="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      <Primary busy={busy}>Join the workspace</Primary>
      {err && <ErrorLine>{err}</ErrorLine>}
    </AuthFrame>
  );
}
