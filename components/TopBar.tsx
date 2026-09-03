"use client";

import { usePathname, useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { usd } from "@/lib/format";
import { useProject } from "@/lib/projectContext";
import Link from "next/link";
import ParticlLockup from "./ParticlMark";

type Usage = { pending: number; spentUsd: number; remainingUsd: number; vendors?: { label: string; remaining: number; added: number }[] };

/**
 * A thin strip, mostly empty on purpose: what screen you're on is said by the
 * screen's own title, so this carries only what is true everywhere — the
 * project you're working in, whether anything is rendering, and what the
 * month has cost so far.
 */
export default function TopBar({ action }: { action?: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { current, selection } = useProject();
  const { data: usage } = useApi<Usage>("/api/usage/summary", 20000);

  const onGenerate = path === "/" || path.startsWith("/generate") || path.startsWith("/images");
  const title = onGenerate
    ? (selection === "all" ? "All projects" : selection === "unfiled" ? "Unfiled" : current?.name ?? "")
    : "";

  return (
    <header className="app-title flex items-center gap-3">
      {/* The brand is on every screen, never loud: the mark, the name, and
          on Generate the project you're in as a tappable breadcrumb. */}
      <Link href="/" className="flex shrink-0 items-center" title="particl studio">
        <ParticlLockup size={19} studio={false} className="max-[430px]:hidden" />
        <ParticlLockup size={19} studio={false} className="min-[431px]:hidden [&_.wordmark]:hidden" />
      </Link>
      {title && (
        <>
          <span className="text-[15px] text-mute" aria-hidden="true">/</span>
          <button
            onClick={() => router.push("/projects")}
            className="min-w-0 truncate text-[15px] font-medium text-dim transition-colors hover:text-ink"
            title="Back to projects"
          >
            {title}
          </button>
        </>
      )}

      <div className="ml-auto flex items-center gap-2.5">
        {usage != null && usage.pending > 0 && (
          <span className="flex items-center gap-2 rounded-full bg-blue/10 px-3 py-1.5 text-[13px] font-medium text-blue">
            <span className="lamp lamp-live" style={{ width: 7, height: 7 }} />
            Rendering {usage.pending > 1 ? usage.pending : ""}
          </span>
        )}
        {usage != null && (
          <span
            className="chip !cursor-default !text-[13px] !text-dim"
            title={usage.vendors?.length
              ? usage.vendors.filter((v) => v.added > 0 || v.remaining < 0).map((v) => `${v.label}: ${usd(v.remaining, 2)} left`).join(" · ") || "No credit recorded yet — see Usage"
              : usage.remainingUsd >= 0
                ? `${usd(usage.remainingUsd, 2)} of recorded credit left`
                : "Spend has passed the credit recorded on the Usage page"}
          >
            {usd(usage.spentUsd, 2)} used
          </span>
        )}
        {action}
      </div>
    </header>
  );
}
