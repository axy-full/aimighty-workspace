"use client";

import Link from "next/link";
import BrandSwitch from "./BrandSwitch";
import { usePathname } from "next/navigation";
import { useProject } from "@/lib/projectContext";
import { useSession, useSignInHref } from "@/lib/session";
import { RequestAccessButton } from "@/components/RequestAccess";

/**
 * The atomik shell header, from the pipeline handoff.
 *
 * The same 52px row as particl's, on paper instead of ink: the `at◯mık BY
 * PARTICL` wordmark, a divider, the production switcher, the four-stage nav
 * in mono, and on the right a link back into particl carrying particl's
 * own mark in currentColor. atomik is where the WORDS of a production live
 * — idea, treatment, breakdown, shot list — and particl is where the
 * renders live, so the way across is always on screen.
 *
 * It renders inside `.theme-light`, which re-tokens the subtree, so every
 * class here is the same class the dark header uses. Nothing is duplicated
 * for the sake of the ground it sits on.
 */

const STAGES = [
  { href: "/atomik/ideas", label: "IDEAS" },
  { href: "/atomik/treatment", label: "TREATMENT" },
  { href: "/atomik/breakdown", label: "BREAKDOWN" },
  { href: "/atomik/shots", label: "SHOT LIST" },
];

export default function AtomikHeader() {
  const path = usePathname();
  const { signedIn, name } = useSession();
  const signIn = useSignInHref();
  const { current, selection } = useProject();
  const onIdeas = path.startsWith("/atomik/ideas") || path === "/atomik";
  const label = onIdeas || !current || selection === "all" ? "All ideas" : current.name;
  const initials = (name ?? "")
    .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "—";

  return (
    <header className="hdr">
      {/* The logo is the switch between the two rooms; IDEAS in the nav is home. */}
      <BrandSwitch side="atomik" />

      <span className="hdr-rule" aria-hidden="true" />

      <Link href="/projects" className="hdr-switch hdr-switch-paper">
        <span>{label}</span>
        <span className="hdr-caret" aria-hidden="true">▼</span>
      </Link>

      <nav className="hdr-nav" aria-label="Stages">
        {STAGES.map((s) => {
          const on = path.startsWith(s.href) || (s.href === "/atomik/ideas" && path === "/atomik");
          return <Link key={s.href} href={s.href} aria-current={on ? "page" : undefined} className={`hdr-tab ${on ? "is-on" : ""}`}>{s.label}</Link>;
        })}
      </nav>

      <div className="hdr-right">
        <Link href="/" className="hdr-mono-link hdr-cross" title="Open this production in particl">
          <span className="hdr-open-long">OPEN IN </span>PARTICL →
          <svg viewBox="30 68 140 64" width="26" height="12" fill="currentColor" aria-hidden="true">
            <circle cx="38.7" cy="120.8" r="1.8" /><circle cx="50.9" cy="100.5" r="2.8" />
            <circle cx="69.8" cy="86.3" r="4" /><circle cx="92.7" cy="80.1" r="5.5" />
            <circle cx="116.2" cy="83" r="7.2" /><circle cx="136.9" cy="94.5" r="9.2" />
            <circle cx="151.7" cy="112.9" r="12" />
          </svg>
        </Link>
        {signedIn ? (
          <Link href="/settings" className="hdr-avatar" title={name ?? "Settings"}>{initials}</Link>
        ) : (
          <>
            <RequestAccessButton className="hdr-mono-link" />
            <a href={signIn} className="btn-primary !h-8 !px-3.5 !text-[12.5px]">Sign in</a>
          </>
        )}
      </div>
    </header>
  );
}
