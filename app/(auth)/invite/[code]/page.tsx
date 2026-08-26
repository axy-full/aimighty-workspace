"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthCard, Field, Submit, ErrorLine } from "@/components/AuthCard";

/** Accepting an invite: the invitee chooses their own password. */
export default function InvitePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setErr("Passwords don't match."); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/auth/accept", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, password }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not accept the invite");
      router.push("/");
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Set your password"
      sub="You've been invited to the aimighty workspace. Choose a password and you're in.">
      <form onSubmit={submit}>
        <Field label="Password">
          <input className="ctl" type="password" autoComplete="new-password" required
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm">
          <input className="ctl" type="password" autoComplete="new-password" required
            value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <Submit busy={busy}>Join the workspace</Submit>
        {err && <ErrorLine>{err}</ErrorLine>}
      </form>
    </AuthCard>
  );
}
