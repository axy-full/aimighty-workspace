"use client";
import dynamic from "next/dynamic";
import type { Project } from "@/lib/workbench/studio";
import { useWorkspace } from "@/lib/workspace/state";
import type { PageId } from "@/lib/workspace/types";

const opening = (label: string) => {
  function Opening() {
    return <p className="pxw-spec-work-empty" role="status">Opening {label}…</p>;
  }
  return Opening;
};

/* Each tool loads with its page; the 3D runtime and the Studio panels never
   ship to a page that does not show them. */
const BriefTool = dynamic(() => import("./tools/BriefTool"), { ssr: false, loading: opening("the brief") });
const BoardsTool = dynamic(() => import("./tools/BoardsTool"), { ssr: false, loading: opening("the boards") });
const AstraTool = dynamic(() => import("./tools/AstraTool"), { ssr: false, loading: opening("the 3D scene") });
const DeliverTool = dynamic(() => import("./tools/DeliverTool"), { ssr: false, loading: opening("the delivery") });
const MarketingTool = dynamic(() => import("./tools/MarketingTool"), { ssr: false, loading: opening("Marketing Studio") });
const AtomikTool = dynamic(() => import("./tools/AtomikTool"), { ssr: false, loading: opening("the agent") });
const SubatomikTool = dynamic(() => import("./tools/SubatomikTool"), { ssr: false, loading: opening("the viral studio") });
const Toaster = dynamic(() => import("@/components/workbench/ui/sonner").then((m) => m.Toaster), { ssr: false });

/** Where a card's click lands inside a mounted suite (a section it tags). */
export const FOCUS: Partial<Record<PageId, string>> = { sources: "sources", compare: "history", history: "history" };

export function SpecTool({
  page,
  tool,
  project,
  scope,
  onProject,
}: {
  page: PageId;
  tool: string;
  project: Project | null;
  scope: string | null;
  onProject: (project: Project) => void;
}) {
  const { go } = useWorkspace();
  if (!project || !scope) return <p className="pxw-spec-work-empty">Open a saved project to use this page’s tools.</p>;
  const id = project.id;
  switch (page) {
    case "brief":
      return (
        <>
          <BriefTool key={id} tool={tool} projectId={id} scope={scope} onProject={onProject} onRig={() => go("particl", "rig")} />
          <Toaster theme="dark" position="bottom-center" />
        </>
      );
    case "boards":
      return (
        <>
          <BoardsTool key={id} projectId={id} scope={scope} onProject={onProject} onPage={(target) => go("particl", target)} />
          <Toaster theme="dark" position="bottom-center" />
        </>
      );
    case "astra":
      return (
        <>
          <AstraTool key={id} projectId={id} scope={scope} onProject={onProject} />
          <Toaster theme="dark" position="bottom-center" />
        </>
      );
    case "deliver":
      return <DeliverTool key={id} tool={tool} projectId={id} scope={scope} onProject={onProject} />;
    case "marketing":
      return <MarketingTool tool={tool} project={project} />;
    case "motion":
      return <SubatomikTool key={id} variant="motion-transfer" projectId={id} publish="motion" />;
    case "swap":
      return <SubatomikTool key={id} variant="object-swap" projectId={id} publish="swap" />;
    case "sources":
    case "compare":
    case "history":
      return <SubatomikTool key={id} variant="motion-transfer" projectId={id} publish={null} />;
    case "agent":
    case "runs":
    case "recipes":
    case "approvals":
    case "budget":
    case "models":
    case "generate":
      return <AtomikTool key={id} page={page} project={project} onPage={(target) => go("atomik", target)} />;
    default:
      return null;
  }
}
