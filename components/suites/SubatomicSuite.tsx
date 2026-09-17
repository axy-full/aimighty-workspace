"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowUpRight,
  CalendarDays,
  CheckCheck,
  FolderOpen,
} from "lucide-react";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import { useDraft } from "@/lib/useDraft";
import { useProject } from "@/lib/projectContext";
import { useAtomik } from "@/components/atomik/AtomikProvider";
import { setAtomikRail } from "@/lib/atomikRail";
import { PAGES, suiteHref } from "@/lib/suites";
import type { Project } from "@/lib/workbench/studio";
import AtomikSuite from "./AtomikSuite";

export default function SubatomicSuite() {
  const query = useSearchParams(),
    session = useSession(),
    atomik = useAtomik(),
    production = useProject();
  const page =
    PAGES.subatomic.find((item) => item.id === query.get("page"))?.id ??
    "trends";
  const projectId = query.get("project") ?? undefined;
  const draft = useDraft(`subatomic-sources:${projectId ?? "unselected"}`, {
    sources: "",
    direction: "",
  });
  const project = useApi<{ project: Project | null }>(
    session.requestScope && projectId
      ? `/api/workbench/projects?id=${encodeURIComponent(projectId)}`
      : null,
    0,
    session.requestScope,
  );
  const readyProject =
    !!projectId &&
    project.data?.project?.id === projectId &&
    !!project.data.project.productionProjectId &&
    production.current?.id === project.data.project.productionProjectId;
  if (page === "presets")
    return (
      <AtomikSuite
        pageOverride="recipes"
        heading="Subatomic"
        pageTitle="Presets"
      />
    );
  if (page === "factory")
    return (
      <AtomikSuite
        pageOverride="runs"
        heading="Subatomic"
        pageTitle="Factory"
      />
    );
  return (
    <div className="suite-workspace suite-subatomic">
      <header className="suite-page-intro">
        <div>
          <span className="suite-kicker">
            <i className="suite-dot" style={{ background: "#D48CF5" }} />
            Subatomic
            {project.data?.project ? ` / ${project.data.project.name}` : ""}
          </span>
          <h1>
            {page === "trends"
              ? "A signal worth making."
              : page === "score"
                ? "Review before it goes further."
                : "Prepare the release."}
          </h1>
          <p>
            {page === "trends"
              ? "Bring your source material. Develop a repeatable format, then run it through the factory."
              : page === "score"
                ? "Review generated takes at the existing approval checkpoints."
                : "Turn approved production output into a delivery handoff."}
          </p>
        </div>
      </header>
      {!session.signedIn && (
        <div className="suite-alert">
          Sign in to use your saved projects and production plans.{" "}
          <Link href="/login" className="suite-text-button">
            Sign in
          </Link>
        </div>
      )}
      {project.error && (
        <div className="suite-alert" role="alert">
          {project.error}{" "}
          <button
            className="suite-text-button"
            onClick={() => void project.refresh()}
          >
            Retry
          </button>
        </div>
      )}
      {page === "trends" && (
        <>
          {session.signedIn && !readyProject && (
            <p className="suite-alert" role="status">
              {projectId && !project.data && !project.error
                ? "Opening the selected project…"
                : "Choose a saved project in the header before adding research to Atomik."}
            </p>
          )}
          <section className="suite-panel">
            <div className="suite-section-heading">
              <div>
                <h2>Source desk</h2>
                <p>
                  Paste research links, observations and examples you want to
                  explore. Atomik can work from the details you provide.
                </p>
              </div>
              <span className="suite-badge">Research input</span>
            </div>
            <fieldset
              className="suite-fields"
              disabled={!session.signedIn || !readyProject}
            >
              <label>
                Sources and observations
                <textarea
                  rows={7}
                  maxLength={6000}
                  value={draft.value.sources}
                  onChange={(e) =>
                    draft.set({ ...draft.value, sources: e.target.value })
                  }
                  placeholder="Source URL, what you observed, why it matters…"
                />
              </label>
              <label>
                Creative direction
                <textarea
                  rows={7}
                  maxLength={3000}
                  value={draft.value.direction}
                  onChange={(e) =>
                    draft.set({ ...draft.value, direction: e.target.value })
                  }
                  placeholder="Audience, format, brand boundaries and the idea to test…"
                />
              </label>
            </fieldset>
            <footer className="suite-panel-footer">
              <span>
                Draft kept in this browser for this account and project.
              </span>
              <button
                className="suite-primary"
                disabled={
                  !session.signedIn ||
                  !readyProject ||
                  !draft.value.sources.trim() ||
                  atomik.busy ||
                  !!atomik.recoveryText
                }
                onClick={() => {
                  if (!readyProject) return;
                  atomik.setDraftText(
                    `Develop a repeatable production format from the supplied research. Treat sources as unverified user notes; do not claim to have fetched URLs or measured live popularity. Propose concepts, a production plan and concrete review criteria.\n\nSources:\n${draft.value.sources}\n\nDirection:\n${draft.value.direction}`,
                  );
                  setAtomikRail("expanded");
                }}
              >
                Review with Atomik <ArrowUpRight size={15} />
              </button>
            </footer>
            <p className="suite-footnote">
              No live trend feed is connected. This desk uses your supplied
              research; the planning quote appears in Atomik before execution.
            </p>
          </section>
          <section className="suite-panel">
            <div className="suite-section-heading">
              <div>
                <h2>From research to a repeatable run</h2>
                <p>
                  Use saved recipes with their original context, models and
                  approval steps.
                </p>
              </div>
              <Link
                href={suiteHref("subatomic", projectId, "presets")}
                className="suite-button"
              >
                Open presets <ArrowUpRight size={15} />
              </Link>
            </div>
            <div className="suite-step-row">
              {[
                ["Research", "Define the idea and its evidence."],
                ["Preset", "Reuse a plan with exact production steps."],
                ["Factory", "Generate through quoted stages."],
                ["Review", "Select the takes that meet the brief."],
              ].map(([title, text]) => (
                <div key={title}>
                  <strong>{title}</strong>
                  <span>{text}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
      {page === "score" && (
        <>
          <section className="suite-panel">
            <div className="suite-section-heading">
              <div>
                <h2>Editorial review</h2>
                <p>
                  Identity, continuity, product accuracy and suitability are
                  decisions for your team.
                </p>
              </div>
              <CheckCheck size={20} />
            </div>
            <p className="suite-footnote">
              Predictive engagement scoring is not connected. The approval queue
              below shows real production decisions, without invented virality
              scores.
            </p>
          </section>
          <AtomikSuite
            pageOverride="approvals"
            heading="Subatomic"
            pageTitle="Review queue"
          />
        </>
      )}
      {page === "schedule" && (
        <>
          <section className="suite-panel">
            <div className="suite-section-heading">
              <div>
                <h2>Release handoff</h2>
                <p>
                  Choose the final takes and export them for your publishing
                  team.
                </p>
              </div>
              <CalendarDays size={20} />
            </div>
            <div className="suite-delivery-actions">
              <Link
                className="suite-format"
                href={suiteHref("particl", projectId, "export")}
              >
                <ArrowUpRight size={18} />
                <strong>Delivery package</strong>
                <span>Prepare final media, EDL and source references.</span>
              </Link>
              <Link
                className="suite-format"
                href={`/library?${new URLSearchParams({ all: "1", ...(projectId ? { project: projectId } : {}) })}`}
              >
                <FolderOpen size={18} />
                <strong>All assets</strong>
                <span>Review uploads and generated outputs by media type.</span>
              </Link>
            </div>
            <p className="suite-footnote">
              Social scheduling is not connected. Export approved work and
              schedule it through your publishing account.
            </p>
          </section>
          <Link
            className="suite-button"
            href={suiteHref("subatomic", projectId, "factory")}
          >
            Review factory runs <ArrowUpRight size={15} />
          </Link>
        </>
      )}
    </div>
  );
}
