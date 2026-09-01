"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AuthCard, Field, Submit, ErrorLine } from "@/components/AuthCard";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not sign in");
      router.push("/");
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Sign in" sub="Particl is for the studio team.">
      <form onSubmit={submit}>
        <Field label="Email">
          <input className="ctl" type="email" autoComplete="username" required
            value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <input className="ctl" type="password" autoComplete="current-password" required
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Submit busy={busy}>Sign in</Submit>
        {err && <ErrorLine>{err}</ErrorLine>}
      </form>
      <p className="mt-4 text-[13px] text-mute">
        <Link href="/welcome" className="text-blue">What is Particl?</Link>
      </p>
    </AuthCard>
  );
}
