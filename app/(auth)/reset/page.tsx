"use client";

/** Forgot password: the registered email gets a single-use link. */
import { useState } from "react";
import { AuthFrame, Eyebrow, Title, Field, Note, Primary, ErrorLine, Links, AuthLink, LINK } from "@/components/auth";
import { RequestAccessButton } from "@/components/RequestAccess";

export default function ResetRequestPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't send the email");
      setSent(json.message ?? "If that address is registered, an email is on its way.");
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  if (sent) {
    return (
      <AuthFrame>
        <Eyebrow>Reset</Eyebrow>
        <Title>Check your inbox</Title>
        <Note tone="ink">{sent}</Note>
        <Note>Nothing there after a few minutes? Check spam, then try again, or <RequestAccessButton className="text-ink underline underline-offset-[3px]" label="contact management" />.</Note>
        <Links><AuthLink href="/login">← Back to sign in</AuthLink></Links>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame onSubmit={submit}>
      <Eyebrow>Reset</Eyebrow>
      <Title>Reset your password</Title>
      <Note>If the address is registered, a link arrives there and works for an hour.</Note>
      <Field label="Email" type="email" name="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      <Primary busy={busy}>Email me a reset link</Primary>
      {err && <ErrorLine>{err}</ErrorLine>}
      <Links>
        <AuthLink href="/login">← Back to sign in</AuthLink>
        <RequestAccessButton className={LINK} label="Request an invite" />
      </Links>
    </AuthFrame>
  );
}
