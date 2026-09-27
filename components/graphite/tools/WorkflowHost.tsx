"use client";
import { useCallback, useEffect, useState } from "react";
import { AtomikVoiceTools, parseVoiceJob, voiceEndpoint, type VoiceCapabilities } from "@/components/suites/AtomikVoiceTools";
import { workflowReason, type WorkflowCapability, type WorkflowSurface } from "@/lib/shell/workflows";
import { useShell } from "@/lib/shell/state";
import { markConnectedCapability, settleConnectedCapability, useConnectedCapability } from "@/lib/shell/use-connected-capability";
import { useSession } from "@/lib/session";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { OwnerRunCard } from "../OwnerRunCard";
import type { Project } from "@/lib/workbench/studio";
import { refreshProjectLibrary } from "@/lib/workspace/library";

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * One connected workflow on a Studio page, in the shell's own frame: the
 * title and line, then the existing voice-tools client (quote → the exact
 * price → run → poll; a dubbed or reframed video is filed on the project, a
 * report is filed as a note) or, when it cannot run, the one reason inline.
 * Opening reads only this project's saved jobs and the account's tool flags.
 * Who owns the workspace comes from the session (idea 19): a member reads
 * nothing and meets the owner-run card instead.
 */
export function WorkflowHost({ surface, scope, project }: { surface: WorkflowSurface; scope: string; project: Project | null }) {
  const { owner } = useConnectedCapability(scope, { read: false });
  return owner ? <OwnerWorkflow surface={surface} scope={scope} project={project} /> : <OwnerRunCard surface="workflows" scope={scope} tools={[surface.title]} />;
}

/** A page's connected workflows: each one for the owner; for a member, one card naming them all (idea 19). */
export function WorkflowHosts({ surfaces, scope, project }: { surfaces: readonly WorkflowSurface[]; scope: string; project: Project | null }) {
  const { owner } = useConnectedCapability(scope, { read: false });
  if (!owner) return <OwnerRunCard surface="workflows" scope={scope} tools={surfaces.map((surface) => surface.title)} />;
  return <>{surfaces.map((surface) => <OwnerWorkflow key={surface.tool} surface={surface} scope={scope} project={project} />)}</>;
}

function OwnerWorkflow({ surface, scope, project }: { surface: WorkflowSurface; scope: string; project: Project | null }) {
  const shell = useShell();
  const scoped = useScopedFetch(scope);
  const session = useSession();
  const suspended = session.workspace?.suspended === true;
  const [capability, setCapability] = useState<WorkflowCapability | null>(null);
  const [capabilities, setCapabilities] = useState<VoiceCapabilities | null>(null);
  const [jobs, setJobs] = useState<ReturnType<typeof parseVoiceJob>[]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const draftId = project?.id ?? null;

  const load = useCallback(async () => {
    if (!draftId) return;
    try {
      const since = markConnectedCapability(scope);
      const response = await scoped(`${voiceEndpoint}?draftId=${encodeURIComponent(draftId)}`, { cache: "no-store" });
      const json = await response.json().catch(() => null) as { connection?: { connected?: boolean; requiresReconnect?: boolean }; capabilities?: unknown; jobs?: unknown[]; error?: string } | null;
      if (!response.ok) throw new Error(json?.error ?? "The connected account could not be read.");
      const caps = record(json?.capabilities) ? json.capabilities : {};
      const languages = Array.isArray(caps.languages)
        ? caps.languages.flatMap((entry) => record(entry) && typeof entry.code === "string" && typeof entry.name === "string" ? [{ code: entry.code.slice(0, 8), name: entry.name.slice(0, 60) }] : [])
        : [];
      setCapabilities({ voice: caps.voice === true, dubbing: caps.dubbing === true, analysis: caps.analysis === true, reframe: caps.reframe === true, languages });
      setJobs(Array.isArray(json?.jobs) && json.jobs.length <= 25 ? json.jobs.map((job) => parseVoiceJob(job, draftId)) : []);
      setRevision((n) => n + 1);
      setCapability({ owner: true, connected: json?.connection?.connected === true && json?.connection?.requiresReconnect !== true, suspended });
      settleConnectedCapability(scope, json?.connection, since);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The connected account could not be read.");
    }
  }, [scoped, draftId, suspended, scope]);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);

  const reason = workflowReason(surface, { hasProject: Boolean(project), capability, capabilities, error });
  const refreshProject = useCallback(async () => { if (draftId) await refreshProjectLibrary(scope, draftId); }, [scope, draftId]);
  return (
    <section className="gx-gen-card gx-workflow" aria-label={surface.title} data-testid={`workflow-${surface.tool}`}>
      <div className="gx-gen-row">
        <span className="gx-eyebrow" data-functional-label="">Connected workflow · {surface.tool.replace("_", " ")}</span>
        <h2 className="gx-workflow-title">{surface.title}</h2>
        <p className="gx-hint">{surface.line}</p>
      </div>
      {reason ? (
        <p className="gx-reason" role="status" data-testid={`workflow-${surface.tool}-reason`}>
          {reason}{reason.includes("Workspace › Engines") ? <> <button type="button" className="cw-link" onClick={() => shell.goWorkspace("engines")}>Open Engines</button></> : null}
        </p>
      ) : project && capability ? (
        <div className="pxw gx-legacy" data-testid={`workflow-${surface.tool}-tool`}>
          <AtomikVoiceTools project={project} scope={scope} tool={surface.tool} capability={capability} capabilities={capabilities} jobs={jobs} revision={revision} refreshProject={refreshProject} />
        </div>
      ) : null}
    </section>
  );
}
