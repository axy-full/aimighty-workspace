"use client";

/** Forgot password: the registered email gets a single-use link. */
import { useState } from "react";
import Link from "next/link";
import { AuthCard, Field, Submit, ErrorLine } from "@/components/AuthCard";
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

  return (
    <AuthCard title="Reset your password" sub="Enter the email you signed up with. If it's registered, a link arrives there and works for an hour.">
      {sent ? (
        <div className="flex flex-col gap-4">
          <p className="rail-help !text-[13.5px] text-ink">{sent}</p>
          <p className="rail-help">Nothing in the inbox after a few minutes? Check spam, then try again, or <RequestAccessButton className="text-ink underline-offset-2 hover:underline" label="contact management" />.</p>
          <Link href="/login" className="hdr-mono-link self-start">← BACK TO SIGN IN</Link>
        </div>
      ) : (
        <form onSubmit={submit}>
          <Field label="Email">
            <input className="ctl" type="email" autoComplete="username" required autoFocus
              value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Submit busy={busy}>Email me a reset link</Submit>
          {err && <ErrorLine>{err}</ErrorLine>}
          <p className="mt-4 flex items-center justify-between text-[12.5px] text-dim">
            <Link href="/login" className="hover:text-ink">← Back to sign in</Link>
            <RequestAccessButton className="hover:text-ink" label="Request an invite" />
          </p>
        </form>
      )}
    </AuthCard>
  );
}
