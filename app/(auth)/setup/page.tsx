"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AuthFrame, Eyebrow, Title, Field, PasswordField, Note, Primary, ErrorLine } from "@/components/auth";

/** First run only: creates the first admin. Refuses once any user exists. */
export default function SetupPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
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
    <AuthFrame onSubmit={submit}>
      <Eyebrow>First run</Eyebrow>
      <Title>Create the first account</Title>
      <Note>Nobody has signed up yet. This one becomes the admin and can invite the rest of the team.</Note>
      <Field label="Name" name="name" autoComplete="name" required value={form.name} onChange={set("name")} autoFocus />
      <Field label="Email" type="email" name="email" autoComplete="username" required value={form.email} onChange={set("email")} />
      <PasswordField name="password" required value={form.password} onChange={set("password")} />
      <Primary busy={busy}>Create admin</Primary>
      {err && <ErrorLine>{err}</ErrorLine>}
    </AuthFrame>
  );
}
