"use client";

/** The link from the email: choose a new password, and you're signed in. */
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthFrame, AuthChecking, Eyebrow, Title, PasswordField, Note, Primary, ErrorLine } from "@/components/auth";

export default function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const [state, setState] = useState<{ email: string } | { dead: string } | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Ask whether the link is still good before showing a form for it.
  useEffect(() => {
    let live = true;
    fetch(`/api/auth/reset/${encodeURIComponent(token)}`)
      .then(async (res) => { const j = await res.json().catch(() => ({})); if (live) setState(res.ok ? { email: j.email } : { dead: j.error ?? "That link isn't valid." }); })
      .catch(() => { if (live) setState({ dead: "Couldn't check the link. Try again." }); });
    return () => { live = false; };
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/auth/reset/${encodeURIComponent(token)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't set the password");
      router.push("/");
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  if (!state) return <AuthChecking what="Checking the link" />;
  if ("dead" in state) {
    return (
      <AuthFrame onSubmit={(e) => { e.preventDefault(); router.push("/reset"); }}>
        <Eyebrow>Reset</Eyebrow>
        <Title>This link won&rsquo;t work</Title>
        <Note>{state.dead}</Note>
        <Primary>Ask for a new link</Primary>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame onSubmit={submit}>
      <Eyebrow>Reset</Eyebrow>
      <Title>Choose a new password</Title>
      <Note>For {state.email}. At least 10 characters. Every other session on the account is signed out when you save.</Note>
      <PasswordField label="New password" name="password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
      <Primary busy={busy}>Save and sign in</Primary>
      {err && <ErrorLine>{err}</ErrorLine>}
    </AuthFrame>
  );
}
