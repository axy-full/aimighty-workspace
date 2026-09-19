"use client";
import { Share, Workflow } from "lucide-react";
import type { Project } from "@/lib/workbench/studio";
import { suiteHref } from "@/lib/suites";
import { avatarGradient, initialsOf } from "@/lib/workspace/format";
import { useWorkspace } from "@/lib/workspace/state";
import { ButtonLink, Segmented } from "./ui";

/** 62px. The real open project; the title never truncates, the subtitle does. */
export function ProjectHeader({ project, loading }: { project: Project | null; loading: boolean }) {
  const { state, dispatch } = useWorkspace();
  const name = project?.name ?? (loading ? "Loading project…" : "No project open");
  const id = project?.id ?? state.projectId ?? "";
  return (
    <div className="pxw-project-head" data-row="project">
      <span className="pxw-project-avatar" aria-hidden="true" style={{ background: project ? avatarGradient(project.id) : "var(--pxw-avatar)" }}>
        {project ? initialsOf(project.name) : ""}
      </span>
      <div className="pxw-project-title-block">
        <div className="pxw-project-title" data-testid="project-title">{name}</div>
        <div className="pxw-project-sub">{project?.description || " "}</div>
      </div>
      {project?.aspect ? <span className="pxw-chip">{project.aspect}</span> : null}
      {project?.fps ? <span className="pxw-chip">{project.fps} fps</span> : null}
      <div className="pxw-spacer" />
      <Segmented
        label="View scope"
        className="pxw-scope"
        value={state.scope}
        onChange={(scope) => dispatch({ type: "patch", patch: { scope } })}
        options={[{ id: "mine", label: "My space" }, { id: "shared", label: "Shared view" }]}
      />
      <ButtonLink href="/pipelines">
        <Workflow size={13} strokeWidth={1.7} aria-hidden="true" />
        <span>Pipelines</span>
      </ButtonLink>
      <ButtonLink href={suiteHref("particl", id || null, "export")}>
        <Share size={13} strokeWidth={1.7} aria-hidden="true" />
        <span>Export</span>
      </ButtonLink>
    </div>
  );
}
