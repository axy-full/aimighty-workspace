"use client";

/**
 * Welcome + Sign in, one screen — from the pipeline handoff.
 *
 * The left half says what particl is, in a lockup and one sentence. The
 * right half is the door: email, password, sign in, and two smaller ways
 * in — ask management for an invitation, or look around signed out,
 * because the interface is open to browse and closed to use.
 *
 * It used to carry a four-cell tour of the app and a paragraph naming
 * every vendor underneath. Both are gone (rule 9). This is the screen a
 * returning member sees every time their session lapses, and their whole
 * business here is one password; a site-map of rooms they already know,
 * linking to pages they are not signed in to reach, is a wall to read
 * past. Whoever genuinely wants the tour has LOOK AROUND, which is the
 * app itself and cannot go stale the way a description of it does.
 *
 * The door is the auth card (board 12i, components/auth): below 1024 the
 * screen is one column — the lockup, the card, the Atomik line — and the
 * card runs full width inside 16px gutters below 768.
 *
 * `next` arrives from the URL, so it is attacker-controlled: it is kept
 * only if it resolves to this origin.
 */
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RequestAccessButton } from "@/components/RequestAccess";
import { AtomikMark } from "@/components/AtomikMark";
import { TRAIL } from "@/components/ParticlMark";
import { Card, Eyebrow, Title, Field, PasswordField, Primary, ErrorLine, Links, AuthLink, LINK } from "@/components/auth";

export default function WelcomeSignIn() {
  return (
    <div className="flex min-h-dvh flex-col bg-ground text-ink lg:grid lg:grid-cols-[minmax(0,1fr)_440px]">
      <section className="flex min-w-0 flex-col justify-between gap-[56px] pt-[56px] pr-[72px] pb-[44px] pl-[64px] max-lg:contents">
        <div className="flex flex-col gap-[36px] max-lg:order-1 max-lg:px-[22px] max-lg:pt-[28px] max-lg:pb-[26px] max-lg:gap-[18px] max-md:px-[16px]">
          <div className="flex items-center gap-[22px]">
            <svg viewBox="30 68 140 64" width="112" height="51" fill="currentColor" aria-hidden="true" className="max-lg:h-[33px] max-lg:w-[72px]">
              {TRAIL.map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r} />)}
            </svg>
            <div className="flex flex-col items-end gap-[6px]">
              <span className="text-[64px] font-semibold leading-none tracking-[-0.03em] text-ink max-lg:text-[44px]">partıcl</span>
              <span className="mr-[2px] font-mono text-[13px] font-medium leading-none tracking-[.36em] text-ink-muted max-lg:text-[11px] max-md:text-[12px]">STUDIO</span>
            </div>
          </div>
          <p className="m-0 max-w-[640px] text-[28px] leading-[1.3] tracking-[-0.01em] text-ink [text-wrap:pretty] max-lg:text-[22px] max-lg:leading-[1.35]">The studio&rsquo;s own room for making shots — and for knowing what they cost.</p>
        </div>

        <div className="flex max-w-[820px] items-end justify-between gap-[40px] max-lg:order-3 max-lg:max-w-none max-lg:px-[22px] max-lg:pt-[22px] max-lg:pb-[32px] max-md:px-[16px]">
          <AuthLink href="/atomik/ideas" className="gap-[9px]"><AtomikMark size={16} /> Idea to shot list · Atomik →</AuthLink>
        </div>
      </section>

      <aside className="flex flex-col justify-center border-l border-border px-[44px] py-[48px] max-lg:order-2 max-lg:border-l-0 max-lg:px-[22px] max-lg:py-[24px] max-md:px-[16px]">
        <Suspense fallback={<SignInForm next="/" />}>
          <SignIn />
        </Suspense>
      </aside>
    </div>
  );
}

function SignIn() {
  const params = useSearchParams();
  return <SignInForm next={safeNext(params.get("next"))} />;
}

function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /**
   * Sign in, and say what went wrong in words a person can act on.
   *
   * This used to be `setErr((e as Error).message)`, which put the browser's
   * own string on the screen: Safari says "Load failed" and Chrome says
   * "Failed to fetch" for the same thing, and neither tells anybody whether
   * the password was wrong, the network dropped, or the server fell over.
   * Three different failures reached that line and all three read the same.
   */
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    let res: Response;
    try {
      res = await fetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
    } catch {
      /* The request never arrived: no connection, or a page left open across
         a deploy holding on to something that has since been replaced. Both
         are fixed by trying again, and the second by reloading. */
      setErr("Couldn't reach particl. Check your connection and try again — and reload the page if this tab has been open a while.");
      setBusy(false);
      return;
    }

    let json: { error?: string } | null = null;
    try { json = await res.json() as { error?: string }; } catch { json = null; }

    if (!res.ok) {
      /* The server's own words when it has any. When it does not — a gateway
         error, an HTML page from somewhere in between — say which code came
         back rather than reporting a JSON parse error, which describes our
         own reading of the answer and not the answer. */
      setErr(json?.error ?? `The server answered ${res.status}. Try again in a moment.`);
      setBusy(false);
      return;
    }
    router.push(next);
    router.refresh();
  }

  return (
    <Card onSubmit={submit} className="mx-auto max-w-[400px]">
      <Eyebrow>Sign in</Eyebrow>
      <Title>Particl is for the studio team</Title>
      <Field label="Email" type="email" name="email" autoComplete="username" required placeholder="you@studio.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      <PasswordField name="password" autoComplete="current-password" required placeholder="••••••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
      <Primary busy={busy}>Sign in</Primary>
      {err && <ErrorLine>{err}</ErrorLine>}
      <Links>
        <RequestAccessButton className={LINK} label="Request an invite" />
        <AuthLink href="/reset">Forgot password?</AuthLink>
      </Links>
      <Links>
        <AuthLink href="/">Look around →</AuthLink>
      </Links>
    </Card>
  );
}

/**
 * A `next` that provably resolves to this origin, or "/". The obvious
 * check — starts with "/" and not "//" — is not enough: browsers normalise
 * a backslash to a slash, and the URL parser strips control characters
 * before resolving, so the test is a resolution, not a string shape.
 */
function safeNext(raw: string | null): string {
  if (!raw) return "/";
  if (/[\u0000-\u001F\u007F]/.test(raw)) return "/";
  if (typeof window === "undefined") return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
  try {
    const here = window.location.origin;
    const u = new URL(raw, here);
    if (u.origin !== here) return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}
