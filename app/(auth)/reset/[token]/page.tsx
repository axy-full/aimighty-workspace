"use client";

/** The link from the email: choose a new password, and you're signed in. */
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthCard, Field, Submit, ErrorLine } from "@/components/AuthCard";

export default function ResetPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const router = useRouter();
  const [state, setState] = useState<
    { email: string } | { dead: string } | null
  >(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Ask whether the link is still good before showing a form for it.
  useEffect(() => {
    let live = true;
    fetch(`/api/auth/reset/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (live)
          setState(
            res.ok
              ? { email: j.email }
              : { dead: j.error ?? "That link isn't valid." },
          );
      })
      .catch(() => {
        if (live) setState({ dead: "Couldn't check the link. Try again." });
      });
    return () => {
      live = false;
    };
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setErr("Passwords don't match.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/auth/reset/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't set the password");
      router.push(json.requiresSignIn ? "/login?passwordReset=1" : "/");
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  if (!state)
    return (
      <AuthCard title="Checking the link…">
        <span />
      </AuthCard>
    );
  if ("dead" in state) {
    return (
      <AuthCard title="This link won't work" sub={state.dead}>
        <Link
          href="/reset"
          className="btn-primary !h-[46px] w-full justify-center !text-[14px]"
        >
          Ask for a new link
        </Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard
      title="Choose a new password"
      sub={`For ${state.email}. At least 10 characters. Every other session on the account is signed out when you save.`}
    >
      <form onSubmit={submit}>
        <Field label="New password">
          <input
            className="ctl"
            type="password"
            autoComplete="new-password"
            required
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Confirm">
          <input
            className="ctl"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <Submit busy={busy}>Save password</Submit>
        {err && <ErrorLine>{err}</ErrorLine>}
      </form>
    </AuthCard>
  );
}
