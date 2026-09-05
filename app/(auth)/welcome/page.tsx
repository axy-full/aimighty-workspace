"use client";

/**
 * Particl's front door.
 *
 * The team signs in at /login and never sees this; it exists for the moment
 * somebody is shown the thing — a new hire, a director, a client asking what
 * the studio actually runs on. So it does one job: say what Particl is,
 * plainly, and get out of the way.
 *
 * Everything on it is the mark's own language — dots on a ring, one of them
 * blue — rather than stock illustration.
 */
import Link from "next/link";
import { INVITE_CONTACT } from "@/lib/session";
import ParticlIntro from "@/components/ParticlIntro";
import { ParticlMark, ParticlStacked } from "@/components/ParticlMark";

const PILLARS = [
  {
    name: "Generate",
    line: "A prompt, a model, a duration. The cost is on the button before you press it.",
  },
  {
    name: "Studio",
    line: "Name a face, a place or a look once. Cite it by name in every shot after.",
  },
  {
    name: "Canvas",
    line: "The sequence on a wall, in order, next to the references it came from.",
  },
  {
    name: "Production",
    line: "What the job cost, who spent it, and which shot is taking the most takes.",
  },
];

export default function WelcomePage() {
  return (
    <>
      <ParticlIntro />

      <main className="w-full max-w-[880px]">
        {/* ── The mark, and the claim ─────────────────────────── */}
        <header className="flex flex-col items-center text-center">
          <h1 className="m-0"><ParticlStacked size={64} /></h1>
          <p className="mt-8 max-w-[36ch] text-[clamp(17px,2.4vw,21px)] leading-snug text-dim">
            A room for making shots — and for knowing what they cost.
            Open to look around; invitation only to use.
          </p>

          {/* Three doors, in the order people arrive at them: look first,
              ask if you like it, sign in if you already have a way in. The
              tool is invite-only, so the ask is a real door and not a
              footnote. */}
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link href="/"
              className="rounded-full bg-blue px-7 py-3 text-[16px] font-medium text-on-ink transition-opacity hover:opacity-90">
              Look around
            </Link>
            <a href={`mailto:${INVITE_CONTACT}?subject=${encodeURIComponent("Particl — invitation request")}`}
              className="chip !px-5 !py-2.5 !text-[15px]">
              Ask for an invite
            </a>
            <Link href="/login" className="text-[14px] text-dim underline underline-offset-4 hover:text-ink">
              Sign in
            </Link>
          </div>
          <p className="mt-4 text-[13px] text-mute">
            Anyone with an invitation can use Particl. Browsing needs nothing.
          </p>
        </header>

        {/* ── The mark, small, as a rule between the claim and the rooms ── */}
        <div className="mt-16 flex items-center justify-center" aria-hidden="true">
          <ParticlMark size={14} className="text-mute/70" />
        </div>

        {/* ── What is in it ───────────────────────────────────── */}
        <section className="mt-16 grid gap-x-10 gap-y-9 sm:grid-cols-2">
          {PILLARS.map((p) => (
            <div key={p.name}>
              <h2 className="text-[19px] font-semibold tracking-[-0.02em] text-ink">
                {p.name}
              </h2>
              <p className="mt-1.5 max-w-[38ch] text-[15px] leading-relaxed text-dim">
                {p.line}
              </p>
            </div>
          ))}
        </section>

        {/* ── The honest footnote ─────────────────────────────── */}
        <footer className="mt-20 border-t border-hair pt-6 text-center">
          <p className="text-[13.5px] leading-relaxed text-mute">
            particl studio runs Seedance on BytePlus ModelArk and Google&rsquo;s Nano Banana
            through Vercel AI Gateway. Masters are stored byte-for-byte and never compressed
            to suit an API.{" "}
            <Link href="/login" className="text-blue">Sign in</Link> to see the
            rest.
          </p>
        </footer>
      </main>
    </>
  );
}
