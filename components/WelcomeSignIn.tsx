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
 * `next` arrives from the URL, so it is attacker-controlled: it is kept
 * only if it resolves to this origin.
 */
import Link from "next/link";
import Image from "next/image";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AtomikMark } from "@/components/AtomikMark";
import { TRAIL } from "@/components/ParticlMark";
import { Mark } from "@/components/ui/Mark";
import "./auth-mobile.css";

export default function WelcomeSignIn() {
  return (
    <div className="wl">
      <section className="wl-left">
        <div className="flex flex-col gap-9">
          <div className="wl-desktop-brand flex items-center gap-[22px]">
            <svg
              viewBox="30 68 140 64"
              width="112"
              height="51"
              fill="currentColor"
              aria-hidden="true"
            >
              {TRAIL.map(([cx, cy, r], i) => (
                <circle key={i} cx={cx} cy={cy} r={r} />
              ))}
            </svg>
            <div className="flex flex-col items-end gap-1.5">
              <span className="wl-word">partıcl</span>
              <span className="wl-studio">STUDIO</span>
            </div>
          </div>
          <div className="hidden auth-mobile-brand">
            <Mark width={26} height={23} />
            <Image src="/brand/particl-wordmark-on-dark@4x.png" alt="particl" width={103} height={31} priority />
          </div>
          <p className="wl-tag">
            <span>Your production house.</span> One workspace for the brief, the crew and
            every take.
          </p>
        </div>

        <div className="wl-foot">
          <Link href="/atomik/ideas" className="wl-atomik">
            <AtomikMark size={16} /> IDEA TO SHOT LIST · ATOMIK →
          </Link>
        </div>
      </section>

      <aside className="wl-right">
        <Suspense fallback={<SignInForm next="/" />}>
          <SignIn />
        </Suspense>
      </aside>
      <footer className="hidden auth-mobile-footer">
        <Link href="/atomik/ideas"><AtomikMark size={20} /> Idea to shot list with Atomik</Link>
        <Link href="/" className="auth-mobile-explore">Look around →</Link>
      </footer>
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
  const [mfaRequired, setMfaRequired] = useState(false);
  const [code, setCode] = useState("");
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
    setBusy(true);
    setErr(null);
    let res: Response;
    try {
      res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          code: mfaRequired ? code : undefined,
        }),
      });
    } catch {
      /* The request never arrived: no connection, or a page left open across
         a deploy holding on to something that has since been replaced. Both
         are fixed by trying again, and the second by reloading. */
      setErr(
        "Couldn't reach particl. Check your connection and try again — and reload the page if this tab has been open a while.",
      );
      setBusy(false);
      return;
    }

    let json: { error?: string; mfaRequired?: boolean } | null = null;
    try {
      json = (await res.json()) as { error?: string; mfaRequired?: boolean };
    } catch {
      json = null;
    }

    if (!res.ok) {
      /* The server's own words when it has any. When it does not — a gateway
         error, an HTML page from somewhere in between — say which code came
         back rather than reporting a JSON parse error, which describes our
         own reading of the answer and not the answer. */
      setErr(
        json?.error ??
          `The server answered ${res.status}. Try again in a moment.`,
      );
      setBusy(false);
      return;
    }
    if (json?.mfaRequired) {
      setMfaRequired(true);
      setBusy(false);
      return;
    }
    setPassword("");
    setCode("");
    router.push(next);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="wl-form">
      <div className="flex flex-col gap-2">
        <h1 className="page-h1">Sign in</h1>
        <p className="page-sub !m-0">Open your studio workspace.</p>
      </div>
      <label className="wl-field">
        EMAIL
        <input
          type="email"
          autoComplete="username"
          required
          placeholder="you@studio.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setMfaRequired(false);
            setCode("");
          }}
        />
      </label>
      <label className="wl-field">
        PASSWORD
        <input
          type="password"
          autoComplete="current-password"
          required
          placeholder="••••••••••"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setMfaRequired(false);
            setCode("");
          }}
        />
      </label>
      {mfaRequired && (
        <label className="wl-field">
          AUTHENTICATOR OR RECOVERY CODE
          <input
            type="text"
            autoComplete="one-time-code"
            autoFocus
            required
            maxLength={24}
            placeholder="Six-digit code or recovery code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <span className="rail-help">
            Enter your authenticator code or one unused recovery code.
          </span>
        </label>
      )}
      <button
        type="submit"
        disabled={busy}
        className="btn-primary !h-[46px] justify-center !text-[14px]"
      >
        {busy ? "…" : "Sign in"}
      </button>
      {err && (
        <p role="alert" className="rail-help text-lift">
          {err}
        </p>
      )}
      <div className="wl-form-foot">
        <span>
          New to Particl?{" "}
          <Link href="/pricing" className="text-lead hover:text-ink">
            View plans
          </Link>{" "}
          ·{" "}
          <Link href="/signup" className="text-lead hover:text-ink">
            Create a workspace
          </Link>
          <br />
          <Link href="/reset" className="text-lead hover:text-ink">
            Forgot password?
          </Link>
        </span>
        <Link href="/" className="hdr-mono-link">
          LOOK AROUND →
        </Link>
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
  if (typeof window === "undefined")
    return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
  try {
    const here = window.location.origin;
    const u = new URL(raw, here);
    if (u.origin !== here) return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}
