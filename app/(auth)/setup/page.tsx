"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AuthCard, Field, Submit, ErrorLine } from "@/components/AuthCard";

/** First run only: creates the first admin. Refuses once any user exists. */
export default function SetupPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password !== form.confirm) { setErr("Passwords don't match."); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Setup failed");
      router.push("/team");
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Create the first account"
      sub="Nobody has signed up yet. This one becomes the admin and can invite the rest of the team.">
      <form onSubmit={submit}>
        <Field label="Name">
          <input className="ctl" required value={form.name} onChange={set("name")} />
        </Field>
        <Field label="Email">
          <input className="ctl" type="email" autoComplete="username" required
            value={form.email} onChange={set("email")} />
        </Field>
        <Field label="Password">
          <input className="ctl" type="password" autoComplete="new-password" required
            value={form.password} onChange={set("password")} />
        </Field>
        <Field label="Confirm">
          <input className="ctl" type="password" autoComplete="new-password" required
            value={form.confirm} onChange={set("confirm")} />
        </Field>
        <Submit busy={busy}>Create admin</Submit>
        {err && <ErrorLine>{err}</ErrorLine>}
      </form>
    </AuthCard>
  );
}
