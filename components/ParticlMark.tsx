"use client";

import { useSession, useSignInHref } from "@/lib/session";
import { usePathname } from "next/navigation";
import { AtomikMark, AtomikSpinner } from "@/components/AtomikMark";
import { RequestAccessButton } from "./RequestAccess";

/**
 * particl studio — the logo system, in code.
 *
 * The mark is seven dots on a 62-radius arc, 22° apart, radii 1.8 → 12: an
 * accelerating particle trail. It is monochrome and takes the ink of its
 * ground through `currentColor`. Never rotated, never recoloured per dot,
 * never stroked — the brand's own rules, and this file keeps them.
 *
 * The wordmark is live type rebuilt from the brand recipe rather than a
 * picture: "partıcl" in Outfit 600 at -0.03em, the ı dotless with a ring
 * tittle (0.17em across, 0.04em stroke, 0.09em down from the em-box top),
 * and "STUDIO" in Kode Mono 500, uppercase, 0.36em tracking, right-aligned
 * under the last letter at 0.21× the wordmark. Because it is type, it is
 * crisp at every size and correct on every ground.
 */

/** [cx, cy, r] on the brand's 200-unit grid. */
export const TRAIL: [number, number, number][] = [
  [38.7, 120.8, 1.8], [50.9, 100.5, 2.8], [69.8, 86.3, 4], [92.7, 80.1, 5.5],
  [116.2, 83, 7.2], [136.9, 94.5, 9.2], [151.7, 112.9, 12],
];
/** The trail's box plus the brand's clear space (the largest dot's height). */
const VIEW = "34 72 132 56";
const RATIO = 132 / 56;

/** The mark alone. `size` is its HEIGHT; it is about 2.4× as wide. */
export function ParticlMark({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={Math.round(size * RATIO)} height={size} viewBox={VIEW} fill="currentColor"
      className={className} aria-hidden="true">
      {TRAIL.map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r} />)}
    </svg>
  );
}

/**
 * The wordmark, from the recipe. `size` is the font size of "partıcl" in px.
 * `studio` adds the STUDIO tag under the last letter.
 */
export function ParticlWordmark({ size = 24, studio = false, className = "" }: {
  size?: number; studio?: boolean; className?: string;
}) {
  return (
    <span className={`wordmark ${className}`} style={{ fontSize: size }} aria-label={studio ? "particl studio" : "particl"}>
      <span className="wordmark-word" aria-hidden="true">
        part<span className="wordmark-i">ı<span className="wordmark-ring" /></span>cl
      </span>
      {studio && <span className="wordmark-studio" aria-hidden="true">studio</span>}
    </span>
  );
}

/**
 * The horizontal lockup: mark, a mark-height of air, the wordmark. `size`
 * is the wordmark's font size; the mark stands half as tall, as in the
 * brand sheet.
 */
export default function ParticlLockup({ size = 26, studio = true, className = "" }: {
  size?: number; studio?: boolean; className?: string;
}) {
  const markH = Math.round(size * 0.5);
  return (
    <span className={`inline-flex items-center text-ink ${className}`} style={{ gap: markH }}>
      <ParticlMark size={markH} />
      <ParticlWordmark size={size} studio={studio} />
    </span>
  );
}

/** The stacked lockup, for a front door: the mark over the wordmark. */
export function ParticlStacked({ size = 56, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex flex-col items-center text-ink ${className}`} style={{ gap: Math.round(size * 0.55) }}>
      <ParticlMark size={Math.round(size * 0.95)} />
      <ParticlWordmark size={size} studio />
    </span>
  );
}

/**
 * The loader: the trail's own motion. Each dot breathes in turn along the
 * arc, so a wait looks like the brand thinking rather than a generic
 * spinner. Pure CSS; respects reduced motion.
 */
export function ParticlSpinner({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={Math.round(size * RATIO)} height={size} viewBox={VIEW} fill="currentColor"
      className={`particl-spin ${className}`} role="status" aria-label="Loading">
      {TRAIL.map(([cx, cy, r], i) => (
        <circle key={i} cx={cx} cy={cy} r={r} style={{ animationDelay: `${i * 90}ms` }} />
      ))}
    </svg>
  );
}

/** A wait that's worth a sentence. Centred, quiet, branded. */
/**
 * Waiting for data — or, for a visitor, waiting for nothing.
 *
 * A signed-out visitor's requests are never sent, so `data` stays null for
 * ever and every screen that spins on it would spin on it for ever. This is
 * the one place all of them pass through, so this is where the honest
 * answer goes: the panel is empty because the work behind it is private,
 * not because the app is slow.
 */
export function Waiting({ label = "Loading", what }: { label?: string; what?: string }) {
  const { signedIn } = useSession();
  const atomik = useInAtomik();
  if (!signedIn) return <SignedOut what={what} />;
  return (
    <div className="screen grid place-items-center">
      <div className="flex flex-col items-center gap-3 text-dim">
        {atomik ? <AtomikSpinner size={26} /> : <ParticlSpinner size={26} />}
        <p className="text-[14px]">{label}</p>
      </div>
    </div>
  );
}

/**
 * What a visitor sees where the studio's work would be.
 *
 * Deliberately not an error and not a wall: they have found the right
 * place, the screen around it is real, and this says what is missing and
 * how to get it. The invitation line matters as much as the button — the
 * product is invite-only, so "sign in" alone would be a dead end for
 * everyone who does not already have an account.
 */
export function SignedOut({ what }: { what?: string }) {
  const signIn = useSignInHref();
  return (
    <div className="screen grid place-items-center">
      <div className="flex max-w-[42ch] flex-col items-center gap-3 text-center">
        <ParticlMark size={22} className="text-mute" />
        <p className="text-[15px] font-medium text-ink">
          {what ? `${what} are private` : "This is private"}
        </p>
        <p className="text-[13.5px] leading-relaxed text-dim">
          You&rsquo;re looking at the real interface — every control here is the one the
          studio uses. What it holds is only visible once you&rsquo;re signed in.
        </p>
        <span className="mt-1 flex flex-wrap items-center justify-center gap-2">
          <a href={signIn} className="btn-render !px-4 !py-2 !text-[14px]">Sign in</a>
          <RequestAccessButton className="chip !text-[13px]" />
        </span>
      </div>
    </div>
  );
}

/** An empty state that looks designed rather than absent: the mark at rest. */
/**
 * A screen that could not read what it needs. Distinct from Empty, which
 * means "nothing here yet" — telling someone their library is empty when
 * the request actually failed is the more expensive lie of the two.
 */
export function Trouble({ label = "This didn't load", detail, onRetry }: {
  label?: string; detail?: string | null; onRetry?: () => void;
}) {
  return (
    <div className="screen grid place-items-center">
      <div className="max-w-[44ch] text-center">
        <p className="text-[16px] font-semibold tracking-[-0.01em]">{label}</p>
        <p className="mt-2 text-[14px] leading-relaxed text-dim">
          The connection or the server had a problem. Nothing has been lost —
          anything rendering carries on.
        </p>
        {detail && <p className="mt-2 break-words font-mono text-[11.5px] text-mute">{detail}</p>}
        {onRetry && (
          <button type="button" onClick={onRetry} className="chip mt-4 !text-blue">Try again</button>
        )}
      </div>
    </div>
  );
}

export function Empty({ title, line, action, compact = false }: {
  title: string; line?: string; action?: React.ReactNode; compact?: boolean;
}) {
  const atomik = useInAtomik();
  return (
    <div className={`flex flex-col items-center text-center ${compact ? "py-6" : "py-10"}`}>
      {atomik
        ? <AtomikMark size={compact ? 18 : 26} className="text-mute/70" />
        : <ParticlMark size={compact ? 18 : 26} className="text-mute/70" />}
      <p className={`mt-3 font-medium text-dim ${compact ? "text-[14px]" : "text-[15px]"}`}>{title}</p>
      {line && <p className="mt-1 max-w-[40ch] text-[13px] leading-relaxed text-mute">{line}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Atomik's screens carry atomik's mark in their waits and empties. */
function useInAtomik(): boolean {
  const path = usePathname();
  return Boolean(path?.startsWith("/atomik"));
}
