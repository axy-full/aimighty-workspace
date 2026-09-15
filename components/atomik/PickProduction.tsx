"use client";

/**
 * The atomik stages after Ideas are about one project. When none is
 * picked, offer the list rather than an empty document.
 */
import { useProject } from "@/lib/projectContext";
import { useSession } from "@/lib/session";
import { Empty } from "@/components/ParticlMark";

export default function PickProduction({ stage }: { stage: string }) {
  const { signedIn } = useSession();
  const { projects, setSelection } = useProject();
  if (!signedIn) return <Empty title={`${stage} is for the team`} line="Sign in to open a project's words." />;
  return (
    <div className="ak-pick">
      <span className="ak-h2">Which project?</span>
      <span className="ak-sub">Pick one and its {stage.toLowerCase()} opens here.</span>
      <div className="ak-pick-list">
        {projects.map((p) => (
          <button key={p.id} type="button" className="ak-pick-row" onClick={() => setSelection(p.id)}>
            <span>{p.name}</span><span className="mono-s">{p.kind ?? "project"}</span>
          </button>
        ))}
        {projects.length === 0 && <span className="ak-sub">No projects yet — pin an idea and write its treatment.</span>}
      </div>
    </div>
  );
}
