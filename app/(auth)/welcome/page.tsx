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
import ParticlIntro from "@/components/ParticlIntro";
import { ParticlMark } from "@/components/ParticlMark";

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
          <ParticlMark size={54} className="text-ink" />
          <h1 className="mt-7 text-[clamp(40px,7vw,68px)] font-semibold leading-[0.98] tracking-[-0.04em] text-ink">
            Particl
          </h1>
          <p className="mt-5 max-w-[34ch] text-[clamp(17px,2.4vw,21px)] leading-snug text-dim">
            The studio&rsquo;s own room for making shots — and for knowing what
            they cost.
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link href="/login"
              className="rounded-full bg-blue px-7 py-3 text-[16px] font-medium text-white transition-opacity hover:opacity-90">
              Sign in
            </Link>
            <span className="text-[14px] text-mute">Invitation only.</span>
          </div>
        </header>

        {/* ── A hairline of particles, doubling as a rule ──────── */}
        <div className="mt-16 flex items-center justify-center gap-2" aria-hidden="true">
          {[2, 3, 4, 5, 6, 5, 4, 3, 2].map((r, i) => (
            <span key={i} className="rounded-full"
              style={{
                width: r, height: r,
                background: i === 4 ? "var(--color-blue)" : "var(--color-bone)",
                opacity: i === 4 ? 1 : 0.18 + r * 0.06,
              }} />
          ))}
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
            Seedance 2.x on BytePlus ModelArk. Masters are stored byte-for-byte
            and never compressed to suit an API.{" "}
            <Link href="/login" className="text-blue">Sign in</Link> to see the
            rest.
          </p>
        </footer>
      </main>
    </>
  );
}
