"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import MarketingStudioFlow, { type MarketingDraftHost } from "@/components/suites/MarketingStudioFlow";
import { DraftUploadInput, type DraftUploadHandle } from "@/components/workbench/DraftUploadInput";
import { moleculrSection } from "@/lib/suites";
import type { Asset, Project } from "@/lib/workbench/studio";
import { usePlanRequest } from "@/lib/workspace/atomik-host";
import { marketingPlanRequests, marketingRequestGaps } from "@/lib/workspace/marketing-requests";
import { useWorkspace } from "@/lib/workspace/state";
import { useDraftEditor } from "@/lib/workspace/use-draft-editor";
import "./studio-css";
import { DraftGate, DraftStatus } from "./DraftStatus";
import { MarketingPlanPanel } from "./MarketingPlanPanel";

/**
 * Marketing Studio itself, inside the workspace shell.
 *
 * The page mounts MarketingStudioFlow — the same component /workbench mounts,
 * with the same four sections, the same campaign actions and the same
 * generation dialog. There is no second copy of the paid path and no second
 * quote or approval: the flow's dialog prices and dispatches, and the page's
 * Atomik plan runs on the shell's engine.
 *
 * What the flow asks of a host, this page answers from the workspace:
 *  - the draft engine is `useDraftEditor` (the revision-checked save every
 *    workspace page uses);
 *  - `onUpload` mounts the shared categorised picker (DraftUploadInput), the
 *    same input and upload path Studio uses;
 *  - `onIdentity` navigates to Cast, which already owns identity creation with
 *    its live-priced approval — never a second identity panel;
 *  - the agent slot is the page's own Atomik plan (MarketingPlanPanel).
 *
 * It also publishes what that plan prices: the /api/generate body of every
 * variant whose engine, ratio, resolution and length Marketing Studio already
 * accepted, read from the draft as edited on this screen.
 */
export default function MarketingTool({
  tool,
  project,
  scope,
  onProject,
}: {
  tool: string;
  project: Project;
  scope: string;
  /** Report the edited draft up so the page's cards and Inspector count what is on screen. */
  onProject: (project: Project) => void;
}) {
  const { go, dispatch } = useWorkspace();
  const editor = useDraftEditor(scope, project.id);
  const live = editor.project && editor.project.id === project.id ? editor.project : null;
  /* The draft at call time: the flow re-reads it across every await, so it
     tracks both the editor's state and this render's own changes (Studio's
     pRef does exactly this). */
  const latest = useRef<Project>(project);
  useEffect(() => {
    latest.current = live ?? project;
  }, [live, project]);

  /* A section link and the page's tool control choose the same open section. */
  const [section, setSection] = useState<string | null>(() => moleculrSection(tool));
  const chosen = moleculrSection(tool);
  const [lastTool, setLastTool] = useState(tool);
  if (lastTool !== tool) {
    setLastTool(tool);
    if (chosen) setSection(chosen);
  }

  useEffect(() => {
    if (live) onProject(live);
  }, [live, onProject]);

  const [uploads, setUploads] = useState(0);
  const picker = useRef<DraftUploadHandle>(null);

  /* The plan sends exactly these bodies; it never invents one. */
  const variants = useMemo(() => marketingPlanRequests(live), [live]);
  const gaps = useMemo(() => marketingRequestGaps(live), [live]);
  usePlanRequest("variants", variants.length ? variants : undefined);

  /* Rebuilt every render on purpose: the flow must call this render's save,
     never a captured older one. */
  const change = useCallback(
    (fn: (previous: Project) => Project) =>
      editor.change((old) => {
        const next = fn(old);
        latest.current = next;
        return next;
      }),
    [editor],
  );
  const host: MarketingDraftHost = {
    scope,
    project: live ?? project,
    latest: () => latest.current,
    /* No project switching happens under a workspace page: the draft is the URL's. */
    live: () => editor.status === "ready",
    owns: (draftId) => latest.current.id === draftId && editor.status !== "error",
    change,
    /* useDraftEditor re-reads identities with the draft, so the flag needs no separate pass. */
    ensureSaved: (draftId) => (draftId === latest.current.id ? editor.ensureSaved() : Promise.resolve(false)),
    beginUpload: () => setUploads((count) => count + 1),
    endUpload: () => setUploads((count) => Math.max(0, count - 1)),
    updateAsset: (id, fields) =>
      change((old) => ({ ...old, assets: old.assets.map((asset) => (asset.id === id ? { ...asset, ...fields } : asset)) })),
  };

  const onAssets = useCallback(
    (assets: Asset[], category: string) => {
      if (!assets.length) return;
      change((old) => ({ ...old, assets: [...old.assets, ...assets] }));
      toast.success(`${assets.length.toLocaleString("en-US")} ${category.toLowerCase()} ${assets.length === 1 ? "reference" : "references"} added`);
    },
    [change],
  );

  if (editor.status !== "ready" || !live) return <DraftGate editor={editor} label="Marketing Studio" />;
  return (
    <div className="pxw-tool pxw-tool--marketing" data-tool-body="marketing">
      <DraftStatus editor={editor}>
        {uploads ? <span className="pxw-draft-state" role="status">Uploading…</span> : null}
      </DraftStatus>
      {gaps.length ? (
        <div className="pxw-package-gaps" data-testid="marketing-plan-gaps">
          <span>
            {gaps.length.toLocaleString("en-US")} {gaps.length === 1 ? "variant is" : "variants are"} not priced by this page&rsquo;s plan yet:
          </span>
          <ul>
            {gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <DraftUploadInput
        handle={picker}
        scope={scope}
        onAssets={onAssets}
        onError={(message) => toast.error(message)}
        onBusy={(busy) => setUploads((count) => (busy ? count + 1 : Math.max(0, count - 1)))}
      />
      <MarketingStudioFlow
        draft={host}
        enabled
        page="marketing"
        section={section}
        marketing={<MarketingPlanPanel />}
        onPage={(target) => setSection(moleculrSection(target) ?? section)}
        onUpload={(category) => picker.current?.pick(category)}
        /* Cast owns identity creation and its live-priced approval. */
        onIdentity={() => go("particl", "cast")}
        onStage={(stage) => go("particl", stage)}
        onRig={() => go("particl", "rig")}
        /* The sequence is the Edit page's; the take is already filed to the project. */
        onSequence={() => go("particl", "edit")}
        onAgent={() => dispatch({ type: "patch", patch: { agentOpen: true } })}
        onDispatched={() => dispatch({ type: "patch", patch: { agentOpen: true } })}
        onSaved={() => void editor.refresh()}
      />
    </div>
  );
}
