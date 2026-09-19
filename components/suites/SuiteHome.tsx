"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUpRight, ChevronDown, FolderOpen, Plus } from "lucide-react";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import { useProject } from "@/lib/projectContext";
import { withPageLeaveGuard } from "@/lib/usePageLeaveGuard";
import { useAtomik } from "@/components/atomik/AtomikProvider";
import { setAtomikRail } from "@/lib/atomikRail";
import { RequestAccessButton } from "@/components/RequestAccess";
import { SUITES, suiteHref } from "@/lib/suites";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/workbench/ui/dropdown-menu";
import { useSuiteProject } from "./SuiteProjectContext";

const descriptions = {
  particl:
    "From the first brief to the final delivery. Eight connected production stages.",
  atomik: "Plan the work, choose the engines and approve each priced stage.",
  moleculr:
    "Build your brand, develop campaigns and create consistent campaign assets in one Marketing Studio.",
  subatomik: "Transfer movement and rework subjects with Genjutsu, on your connected credits.",
};
export default function SuiteHome() {
  const session = useSession(),
    atomik = useAtomik(),
    router = useRouter(),
    query = useSearchParams(),
    suiteProject = useSuiteProject(),
    production = useProject();
  const projectId = query.get("project") || suiteProject.projectId;
  const drafts = useApi<{
    projects: { id: string; name: string; updatedAt: string }[];
    project: { id: string; productionProjectId?: string } | null;
  }>(
    session.requestScope
      ? `/api/workbench/projects${projectId ? `?id=${encodeURIComponent(projectId)}` : ""}`
      : null,
    0,
    session.requestScope,
  );
  const readyContext =
    suiteProject.ready &&
    (!projectId ||
      (drafts.data?.project?.id === projectId &&
        !!drafts.data.project.productionProjectId &&
        production.current?.id === drafts.data.project.productionProjectId));
  const recent = drafts.data?.projects ?? [];
  const open = (href: string) => {
    void withPageLeaveGuard(() => router.push(href));
  };
  const brief = (
    <section className="suite-home-brief">
      <div>
        <span className="suite-kicker">
          <i className="suite-dot" style={{ background: "#f0b23e" }} />
          {session.signedIn
            ? (session.workspace?.name ?? "Your workspace")
            : "Four suites. One connected workspace."}
        </span>
        <h1>
          {session.signedIn
            ? "What are we making?"
            : "From an idea to the final frame."}
        </h1>
        <p>
          {session.signedIn
            ? "Bring your brief. Connect the references. Let Atomik help turn the next idea into a production plan."
            : "A connected studio for films, campaigns and content. One library, a shared production context, and approval before generation."}
        </p>
        {session.signedIn ? (
          <>
            <label className="sr-only" htmlFor="suite-home-brief">
              Your next production brief
            </label>
            <textarea
              id="suite-home-brief"
              className="suite-plain-textarea"
              rows={3}
              value={readyContext ? atomik.draftText : ""}
              disabled={!readyContext || atomik.busy || !!atomik.recoveryText}
              maxLength={6000}
              placeholder="A campaign, a scene, a world to build…"
              onChange={(e) => atomik.setDraftText(e.target.value)}
            />
            <button
              className="suite-primary"
              disabled={!readyContext || !atomik.draftText.trim()}
              onClick={() => {
                if (readyContext) setAtomikRail("expanded");
              }}
            >
              Review with Atomik <ArrowUpRight size={15} />
            </button>
            <small className="suite-footnote">
              {readyContext
                ? `Review the planning quote in Atomik before running${production.current ? ` for ${production.current.name}` : ""}.`
                : "Opening the selected project. Choose a saved project above if it is unavailable."}
            </small>
          </>
        ) : (
          <div className="suite-recipe-chips">
            <RequestAccessButton className="suite-primary" />
            <Link className="suite-button" href="/login">
              Sign in <ArrowUpRight size={15} />
            </Link>
          </div>
        )}
      </div>
      <Image
        src="/campaign/hero.webp"
        alt="Production study: a character and a mirrored sphere in a desert landscape"
        width={900}
        height={600}
        priority
      />
    </section>
  );
  const chips = (
    <div className="suite-recipe-chips">
      <Link href={suiteHref("particl", projectId, "brief")}>
        Break down a screenplay
      </Link>
      <Link href={suiteHref("moleculr", projectId)}>
        Build a product campaign
      </Link>
      <Link href={suiteHref("atomik", projectId, "recipes")}>
        Start from a saved recipe
      </Link>
    </div>
  );
  const cards = (
    <div className="suite-home-cards">
      {SUITES.map((suite) => (
        <Link
          className="suite-home-card"
          href={suiteHref(suite.id, projectId)}
          key={suite.id}
        >
          <span>
            <i className="suite-dot" style={{ background: suite.color }} />
            {suite.name}
          </span>
          <p>{descriptions[suite.id]}</p>
          <ArrowUpRight size={18} />
        </Link>
      ))}
    </div>
  );
  return (
    <div className="suite-workspace suite-home">
      {session.signedIn ? (
        <>
          <section className="suite-home-projects" aria-label="Projects">
            <div className="suite-section-heading">
              <div>
                <h2>Recent projects</h2>
                <p>
                  The original assets, decisions and runs stay with each project.
                </p>
              </div>
              <div className="suite-recipe-chips">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="suite-button"
                      type="button"
                      disabled={!recent.length}
                      aria-label="Open a saved project"
                    >
                      <FolderOpen size={15} />
                      Open a saved project
                      <ChevronDown size={13} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="suite-switcher-menu" align="end">
                    {recent.map((project) => (
                      <DropdownMenuItem
                        key={project.id}
                        onSelect={() =>
                          open(suiteHref("particl", project.id, "canvas"))
                        }
                      >
                        {project.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Link className="suite-button" href="/workbench?new=1">
                  <Plus size={15} />
                  New project
                </Link>
              </div>
            </div>
            {drafts.error ? (
              <div className="suite-alert" role="alert">
                {drafts.error}{" "}
                <button
                  className="suite-text-button"
                  onClick={() => void drafts.refresh()}
                >
                  Retry
                </button>
              </div>
            ) : !drafts.data ? (
              <p className="suite-footnote" role="status">
                Loading projects…
              </p>
            ) : recent.length ? (
              <div className="suite-recent-projects">
                {recent.slice(0, 9).map((project) => (
                  <Link
                    key={project.id}
                    href={suiteHref("particl", project.id, "canvas")}
                  >
                    <span>
                      <strong>{project.name}</strong>
                      <small>Open production</small>
                    </span>
                    <ArrowUpRight size={16} />
                  </Link>
                ))}
              </div>
            ) : (
              <div className="suite-empty">
                <p>Start a project to connect production, agents and brand building.</p>
                <Link className="suite-primary" href="/workbench?new=1">
                  Create a project
                </Link>
              </div>
            )}
          </section>
          {cards}
          {brief}
          {chips}
        </>
      ) : (
        <>
          {brief}
          {chips}
          {cards}
          <section className="suite-panel">
            <div className="suite-section-heading">
              <div>
                <h2>A production you can follow.</h2>
                <p>
                  Choose the creative direction. Keep control of the execution.
                </p>
              </div>
            </div>
            <div className="suite-step-row">
              {[
                ["01 · Brief", "Start with the script, product or idea."],
                [
                  "02 · Plan",
                  "Connect assets and review the proposed production steps.",
                ],
                [
                  "03 · Approve",
                  "Check the engine, references and credit quote.",
                ],
                [
                  "04 · Deliver",
                  "Review original takes, finish the edit and export.",
                ],
              ].map(([title, body]) => (
                <div key={title}>
                  <strong>{title}</strong>
                  <span>{body}</span>
                </div>
              ))}
            </div>
            <footer className="suite-panel-footer">
              <span>Invitation-only workspaces for production teams.</span>
              <Link href="/billing" className="suite-button">
                Plans & credits <ArrowUpRight size={15} />
              </Link>
            </footer>
          </section>
        </>
      )}
    </div>
  );
}
