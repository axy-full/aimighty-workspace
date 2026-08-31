"use client";

import { usePathname, useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { usd } from "@/lib/format";
import { useProject } from "@/lib/projectContext";

type Usage = { pending: number; spentUsd: number; remainingUsd: number };

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

  const onGenerate = path.startsWith("/generate");
  const title = onGenerate
    ? (selection === "all" ? "All projects" : selection === "unfiled" ? "Unfiled" : current?.name ?? "")
    : "";

  return (
    <header className="app-title flex items-center gap-3 px-6 max-[860px]:px-3.5">
      {title && (
        <button
          onClick={() => router.push("/")}
          className="chip !bg-transparent !px-0 !text-[15px] font-semibold hover:!bg-transparent"
          title="Back to projects"
        >
          {title}
        </button>
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
            title={usage.remainingUsd >= 0
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
