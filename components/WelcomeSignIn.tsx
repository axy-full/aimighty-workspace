"use client";

/**
 * Welcome + Sign in, one screen — from the pipeline handoff.
 *
 * The left half says what Particl is: the lockup, one sentence, the four
 * rooms with their own site copy, and the honest footnote about what runs
 * underneath. The right half is the door: email, password, sign in, and
 * two smaller ways in — ask management for an invitation, or look around
 * signed out, because the interface is open to browse and closed to use.
 *
 * `next` arrives from the URL, so it is attacker-controlled: it is kept
 * only if it resolves to this origin.
 */
import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RequestAccessButton } from "@/components/RequestAccess";
import { AtomikMark } from "@/components/AtomikMark";
import { TRAIL } from "@/components/ParticlMark";
import DemoWall from "@/components/DemoWall";

const ROOMS = [
  { eyebrow: "01 · VIDEO · IMAGES · AUDIO", name: "Generate", href: "/", line: "A prompt, an engine, a duration. The cost is on the button before you press it." },
  { eyebrow: "02 · STUDIO", name: "Studio", href: "/studio", line: "Name a face, a place or a look once. Cite it by name in every shot after." },
  { eyebrow: "03 · PRODUCTIONS", name: "Productions", href: "/projects", line: "Every take under its shot, in order, next to the references it came from." },
  { eyebrow: "04 · USAGE", name: "Usage", href: "/usage", line: "What the job cost, who spent it, and which shot is taking the most takes." },
];

export default function WelcomeSignIn() {
  return (
    <div className="wl">
      <section className="wl-left">
        <div className="flex flex-col gap-9">
          <div className="flex items-center gap-[22px]">
            <svg viewBox="30 68 140 64" width="112" height="51" fill="currentColor" aria-hidden="true">
              {TRAIL.map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r} />)}
            </svg>
            <div className="flex flex-col items-end gap-1.5">
              <span className="wl-word">partıcl</span>
              <span className="wl-studio">STUDIO</span>
            </div>
          </div>
          <p className="wl-tag">The studio&rsquo;s own room for making shots — and for knowing what they cost.</p>
        </div>

        <span className="wl-rooms" aria-hidden="true">THE FOUR ROOMS</span>
        <div className="wl-grid">
          {ROOMS.map((r) => (
            <Link key={r.name} href={r.href} className="wl-cell">
              <span className="mono !tracking-[.18em] !text-[10px]">{r.eyebrow}</span>
              <span className="wl-cell-h">{r.name}</span>
              <span className="wl-cell-p">{r.line}</span>
            </Link>
          ))}
        </div>

        <div className="wl-foot">
          <p>particl studio runs Seedance on BytePlus ModelArk, Nano Banana on Google, Kling and Topaz on fal.ai, and ElevenLabs for sound. Masters are stored byte-for-byte and never compressed to suit an API.</p>
          <Link href="/atomik/ideas" className="wl-atomik"><AtomikMark size={16} /> IDEA TO SHOT LIST · ATOMIK →</Link>
        </div>
      </section>

      <aside className="wl-right">
        <Suspense fallback={<SignInForm next="/" />}>
          <SignIn />
        </Suspense>
      </aside>
      <DemoWall />
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
    <form onSubmit={submit} className="wl-form">
      <div className="flex flex-col gap-2">
        <h1 className="page-h1">Sign in</h1>
        <p className="page-sub !m-0">Particl is for the studio team.</p>
      </div>
      <label className="wl-field">EMAIL
        <input type="email" autoComplete="username" required placeholder="you@studio.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="wl-field">PASSWORD
        <input type="password" autoComplete="current-password" required placeholder="••••••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <button type="submit" disabled={busy} className="btn-primary !h-[46px] justify-center !text-[14px]">{busy ? "…" : "Sign in"}</button>
      {err && <p className="rail-help text-lift">{err}</p>}
      <div className="wl-form-foot">
        <span>Invitation only. <RequestAccessButton className="text-lead hover:text-ink" /> · <Link href="/reset" className="text-lead hover:text-ink">Forgot password?</Link></span>
        <Link href="/" className="hdr-mono-link">LOOK AROUND →</Link>
      </div>
    </form>
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
