"use client";
import type { Project } from "@/lib/workbench/studio";
import { suiteHref } from "@/lib/suites";
import { generateAvailability, type Availability } from "@/lib/workspace/navigation";
import { agentDot } from "@/lib/workspace/next";
import { pageDef, pageViews, primaryAction, subtitle } from "@/lib/workspace/pages";
import { useWorkspace } from "@/lib/workspace/state";
import type { LibFilter, RigView } from "@/lib/workspace/types";
import { Button, ButtonLink, Segmented } from "./ui";

/** Why the primary action cannot run right now, or null when it can. */
export function primaryAvailability(state: ReturnType<typeof useWorkspace>["state"], onGenerate?: () => void): Availability {
  const action = primaryAction(state.page);
  if (action.kind === "generate") return generateAvailability(state, Boolean(onGenerate));
  return { enabled: true, reason: null };
}

/** 60px. Title + derived sub, views, Run with Atomik, primary, Inspector. */
export function PageHeader({ project, onGenerate }: { project: Project | null; onGenerate?: () => void }) {
  const { state, dispatch, setLibFilter, plans } = useWorkspace();
  const def = pageDef(state.page);
  const views = pageViews(state.page);
  const action = primaryAction(state.page);
  const availability = primaryAvailability(state, onGenerate);
  const plan = plans(state.page);
  const run = state.run && state.run.page === state.page ? state.run : null;
  const waiting = run?.status === "waiting";
  const running = run?.status === "running";
  const chipLabel = waiting
    ? plan?.gatePrice ? `Approve ${plan.gatePrice}` : "Approve"
    : running ? "Pause run" : run?.status === "done" ? "Run again" : run ? "Resume run" : "Run with Atomik";
  const openAgent = () => dispatch({ type: "patch", patch: { agentOpen: true } });
  const projectId = project?.id ?? state.projectId;
  return (
    <div className="pxw-page-head" data-row="page">
      <div className="pxw-page-title-block">
        <h1 className="pxw-page-title" data-testid="page-title">{def.title}</h1>
        <span className="pxw-page-sub" data-testid="page-sub">{subtitle(state, { aspect: project?.aspect, fps: project?.fps })}</span>
      </div>
      <div className="pxw-spacer" />
      {views.length ? (
        <Segmented
          label={`${def.title} view`}
          className="pxw-page-views"
          value={state.page === "rig" ? state.rigView : state.libFilter}
          onChange={(id) => (state.page === "rig" ? dispatch({ type: "patch", patch: { rigView: id as RigView } }) : setLibFilter(id as LibFilter))}
          options={views}
        />
      ) : null}
      <button
        type="button"
        className="pxw-run-chip"
        onClick={openAgent}
        style={{
          background: waiting ? "rgba(255,159,10,.14)" : running ? "rgba(240,178,62,.1)" : "var(--pxw-control)",
          color: waiting ? "var(--pxw-amber-ink)" : running ? "var(--pxw-atomik-panel-gold)" : "var(--pxw-body)",
          borderColor: waiting || running ? "rgba(240,178,62,.4)" : "var(--pxw-control-border)",
        }}
      >
        <span className="pxw-dot" style={{ background: agentDot(state) }} aria-hidden="true" />
        <span>{chipLabel}</span>
      </button>
      {action.kind === "generate" ? (
        <Button
          variant="primary"
          keyHint={action.key}
          disabled={!availability.enabled}
          aria-disabled={!availability.enabled}
          title={availability.reason ?? undefined}
          aria-describedby={availability.reason ? "pxw-action-reason" : undefined}
          onClick={() => availability.enabled && onGenerate?.()}
        >
          <span>{action.label}</span>
        </Button>
      ) : action.kind === "run-stage" ? (
        <Button variant="primary" keyHint={action.key} onClick={openAgent}>
          <span>{action.label}</span>
        </Button>
      ) : (
        /* Upload and Add cast open the existing, working flows for this project. */
        <ButtonLink variant="primary" href={suiteHref("particl", projectId, action.kind === "upload" ? "assets" : "characters")}>
          <span>{action.label}</span>
        </ButtonLink>
      )}
      <button type="button" className="pxw-insp-toggle" aria-pressed={state.inspector} aria-keyshortcuts="I" onClick={() => dispatch({ type: "toggleInspector" })}>
        Inspector
      </button>
    </div>
  );
}
