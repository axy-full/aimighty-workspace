"use client";

import { usePathname, useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useProject } from "@/lib/projectContext";
import ModeSwitch from "./ModeSwitch";

type Usage = { pending: number };

/**
 * A thin strip, mostly empty on purpose: what screen you're on is said by the
 * screen's own title, so this carries only what is true everywhere — the
 * project you're working in and whether anything is rendering.
 *
 * The running spend used to sit in the far corner. A number that only ever
 * goes up, parked in the loudest position on the screen, reads as a meter on
 * a taxi rather than as information — and it is the one figure here that
 * nothing on this bar can act on. It moved to the foot of the projects rail,
 * still glanceable, next to the link to the page that explains it.
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
      {/* The brand is also the switch. Particl and Atomik are the same
          studio at two heights — one renders the shot you describe, the
          other works out what the shots should be — so the control that
          moves between them belongs on the identity, not in the nav. */}
      <ModeSwitch />
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
        {action}
      </div>
    </header>
  );
}
