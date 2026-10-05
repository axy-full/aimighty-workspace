"use client";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { AtomikRunDialog } from "@/components/workbench/AtomikRunDialog";
import { useShell } from "@/lib/shell/state";
import { boardCardId, wantsDesigner, type AdsCardId } from "@/lib/shell/ads-social";
import { hooksRequest, type OwnPage } from "@/lib/shell/business-own";
import { referenceAdBinding, EMPTY_REFERENCE_AD } from "@/lib/workbench/reference-ad";
import { assertReferenceAnalysisSource, referenceAdAnalysisSchema, type ReferenceAdAnalysis } from "@/lib/workbench/reference-ad-analysis";
import { useProjectLibrary } from "@/lib/workspace/library";
import { briefOf } from "../../business/own-kit";
import { BrandTool } from "../../business/BrandTool";
import { FormatTool } from "../../business/FormatTool";
import { HooksTool, SUITE_MODEL } from "../../business/HooksTool";
import { ProductTool } from "../../business/ProductTool";
import { REFERENCE_REVIEW_ASK, ReferenceTool } from "../../business/ReferenceTool";
import { useOwnAgent } from "../../business/use-own-agent";
import type { BoardCtx } from "../cards/types";
import { Designer } from "./Designer";
import { openDesigner, openDialog, openPanel, patchSession, useAdsSession, type AgentSnap, type PanelId } from "./ads-session";
import { freshHooks } from "./ads-model";
import { useRiggedEditor } from "./use-ads-editor";
import "./ads.css";

/*
 * What the Ads board draws over the canvas: the Edit panel for a card (the Business tools' bodies, on the board's one
 * draft), the agent's run dialog (which quotes, then reserves up to the estimate: only a person's press sends), and the
 * poster Designer full screen. It also keeps the Campaign agent's runs read (a free GET) for the cards, and opens what
 * the address asks for (`frame=3`, `card=`).
 */
const TITLES: Record<PanelId, string> = { brand: "Brand kit", product: "Product facts", reference: "Reference ad", hooks: "Hooks", formats: "Format briefs" };
const PANEL_OF_PAGE: Partial<Record<OwnPage, PanelId>> = { brand: "brand", product: "product", reference: "reference", hooks: "hooks", format: "formats" };

export function AdsOverlay({ ctx }: { ctx: BoardCtx }) {
  const shell = useShell();
  const { scope, project, rig } = ctx;
  const pid = project.id;
  const session = useAdsSession(pid);
  const editor = useRiggedEditor(rig);
  const library = useProjectLibrary(scope, pid);
  const saved = Boolean(project.productionProjectId);
  const agent = useOwnAgent(scope, pid, saved);

  /* ── The agent's runs, reduced to what the cards show ── */
  const snap = useMemo<AgentSnap>(() => {
    const jobs = agent.data?.jobs ?? [];
    const live = (j: { status: string }) => j.status === "queued" || j.status === "running";
    const mine = jobs.filter((j) => j.suite === "moleculr" || j.plan?.suiteAgent?.suite === "moleculr");
    const value = briefOf(project).referenceAd ?? EMPTY_REFERENCE_AD;
    let analysis: ReferenceAdAnalysis | null = null;
    for (const job of jobs) {
      const parsed = referenceAdAnalysisSchema.safeParse(job.plan?.referenceAdAnalysis);
      if (!parsed.success || parsed.data.projectId !== pid || parsed.data.jobId !== job.id || parsed.data.evidence.source.assetId !== value.assetId) continue;
      try { assertReferenceAnalysisSource(project, parsed.data.evidence.source); } catch { continue; }
      if (!analysis || parsed.data.createdAt > analysis.createdAt) analysis = parsed.data;
    }
    return {
      ready: Boolean(agent.data), configured: Boolean(agent.data?.configured && agent.data.models.length), error: agent.error ?? null,
      hooksRunning: mine.some(live), referenceRunning: jobs.some((j) => live(j) && j.request === REFERENCE_REVIEW_ASK),
      proposed: mine.slice(0, 4).flatMap((j) => j.plan?.suiteAgent?.hooks ?? []), analysis,
    };
  }, [agent.data, agent.error, pid, project]);
  const sent = useRef<string>("");
  useEffect(() => {
    const key = JSON.stringify(snap);
    if (sent.current === key) return;
    sent.current = key;
    patchSession(pid, { agent: snap });
  }, [pid, snap]);

  /* ── The address: `frame=3` is the Designer; `card=` opens that card's panel and selects it ── */
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (opened.current === pid) return;
    opened.current = pid;
    const card = shell.params.card ?? null;
    if (wantsDesigner("ads", shell.params.frame)) openDesigner(pid, true);
    const id = boardCardId("ads", card);
    if (id) {
      const panel = card && (["brand", "product", "reference", "hooks", "formats"] as string[]).includes(card) ? (card as PanelId) : null;
      if (panel) openPanel(pid, panel);
      const t = setTimeout(() => ctx.select(id), 400);
      return () => clearTimeout(t);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  const close = useCallback(() => openPanel(pid, null), [pid]);
  useEffect(() => {
    if (!session.panel) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== "Escape" || e.defaultPrevented || session.dialog || el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? "")) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, session.dialog, session.panel]);

  const onOpen = useCallback((page: OwnPage) => {
    if (page === "design") { openPanel(pid, null); openDesigner(pid, true); return; }
    const panel = PANEL_OF_PAGE[page];
    if (panel) openPanel(pid, panel);
  }, [pid]);

  const items = library.items;
  const body = session.panel === "brand" ? <BrandTool key="brand" scope={scope} editor={editor} items={items} initial={session.brand?.status === "ready" ? session.brand.result ?? null : null} />
    : session.panel === "product" ? <ProductTool key="product" scope={scope} editor={editor} items={items} initial={session.product?.status === "ready" ? session.product.result ?? null : null} />
    : session.panel === "reference" ? <ReferenceTool key="reference" scope={scope} editor={editor} items={items} onOpen={onOpen} />
    : session.panel === "hooks" ? <HooksTool key="hooks" scope={scope} editor={editor} onOpen={onOpen} />
    : session.panel === "formats" ? <FormatTool key="formats" editor={editor} onOpen={onOpen} /> : null;

  const brief = briefOf(project);
  const room = Math.max(1, 12 - brief.hooks.filter((h) => h.trim()).length);
  const models = agent.data?.models ?? [];
  const referenceBinding = (() => { try { return referenceAdBinding(project, brief.referenceAd); } catch { return undefined; } })();
  const proposed = freshHooks(brief, snap.proposed);

  return (
    <>
      {session.panel ? (
        <aside className="ab-panel" aria-label={TITLES[session.panel]} data-testid="ads-panel" data-panel={session.panel}>
          <header className="ab-panel-head">
            <strong>{TITLES[session.panel]}</strong>
            <span className="ab-panel-save" role="status">{editor.saveState}</span>
            <button type="button" className="ab-btn" onClick={close} data-testid="ads-panel-close">Close</button>
          </header>
          <div className="ab-panel-body nowheel">{body}</div>
        </aside>
      ) : null}
      {session.dialog === "hooks" && saved ? (
        <AtomikRunDialog key={`${scope}:${pid}:hooks`} approximate scope={scope} project={project} models={models.filter((m) => SUITE_MODEL.test(m.id))}
          target={{ suite: "moleculr", request: `[moleculr] ${hooksRequest(brief, room)}`, role: "marketing", model: "auto", effort: "auto", depth: "Considered", refs: [] }}
          onSave={editor.ensureSaved} onClose={() => openDialog(pid, null)} onQueued={() => { openDialog(pid, null); void agent.refresh(); ctx.toast(proposed.length ? "The agent is writing more hooks" : "The agent is writing hooks. They appear on the Hooks card when they are ready."); }} />
      ) : null}
      {session.dialog === "reference" && saved && referenceBinding ? (
        <AtomikRunDialog key={`${scope}:${pid}:reference`} approximate scope={scope} project={project} models={models.filter((m) => (m as { vision?: boolean }).vision)}
          target={{ referenceAd: referenceBinding, role: "marketing", request: REFERENCE_REVIEW_ASK, model: "auto", effort: "auto", depth: "Considered", refs: brief.referenceAd?.assetId ? [brief.referenceAd.assetId] : [] }}
          onSave={editor.ensureSaved} onClose={() => openDialog(pid, null)} onQueued={() => { openDialog(pid, null); void agent.refresh(); ctx.toast("The review is running. It appears on the Reference card when it is ready."); }} />
      ) : null}
      {session.designer ? <Designer ctx={ctx} items={items} onClose={() => openDesigner(pid, false)} /> : null}
    </>
  );
}
