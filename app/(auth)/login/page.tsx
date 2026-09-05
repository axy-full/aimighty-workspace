"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AuthCard, Field, Submit, ErrorLine } from "@/components/AuthCard";
import { INVITE_CONTACT } from "@/lib/session";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  /* Come back to the screen they were looking at. Same-origin paths only:
     `next` arrives from the URL, so an absolute one would make this an open
     redirect that any link could point anywhere. */
  const raw = params.get("next") ?? "/";
  const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
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
      router.push(next);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Sign in" sub="Anyone with an invitation can use Particl.">
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
      {/* The invitation line is the important half of this page now. The
          interface is open to browse and closed to use, so most people
          arriving here have no account and no way to make one — without
          somewhere to ask, "sign in" is a door with no handle. */}
      <p className="mt-4 text-[13px] leading-relaxed text-mute">
        No account?{" "}
        <a className="text-blue" href={`mailto:${INVITE_CONTACT}?subject=${encodeURIComponent("Particl — invitation request")}`}>
          Ask {INVITE_CONTACT} for an invite
        </a>
        .
      </p>
      <p className="mt-2 text-[13px] text-mute">
        <Link href="/welcome" className="text-blue">What is Particl?</Link>
      </p>
    </AuthCard>
  );
}

/**
 * useSearchParams opts a page out of prerendering unless it sits behind a
 * Suspense boundary — and this page is worth prerendering, because it is
 * where everyone who cannot get in is sent. The fallback is the same card
 * with nothing in it, so the shell paints immediately either way.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<AuthCard title="Sign in" sub="Anyone with an invitation can use Particl."><span /></AuthCard>}>
      <LoginForm />
    </Suspense>
  );
}
