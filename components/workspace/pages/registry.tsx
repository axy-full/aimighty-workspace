"use client";
import type { ComponentType } from "react";
import type { Project } from "@/lib/workbench/studio";
import { pageDef } from "@/lib/workspace/pages";
import type { PageId } from "@/lib/workspace/types";
import { RigPage } from "../rig/RigPage";
import { useSession } from "@/lib/session";
import { SpecPage } from "../spec/SpecPage";
import { SpecTool } from "../spec/SpecTool";
import { Kicker } from "../ui";
import { CastPage } from "./CastPage";
import { EditPage } from "./EditPage";
import { TakesPage } from "./TakesPage";

/** Everything a page body receives from the shell. */
export type PageBodyProps = {
  page: PageId;
  project: Project | null;
  /** The request scope (X-Workbench-Scope) every workbench route checks. */
  scope: string;
};

/** One line on what the page will hold. No sample data. */
const COMING: Record<PageId, string> = {
  brief: "The brief, the script and the development passes on one document, scene-numbered.",
  boards: "Boards for every scene, under a collapsible look section they inherit from.",
  cast: "Cast and elements, each with a locked identity reused across shots.",
  astra: "Shots blocked in the 3D runtime and exported back to Rig as a layout.",
  rig: "The shot list, with the node graph as the advanced view.",
  takes: "Every upload and generation in this project, filterable, with settled cost.",
  edit: "The assembly and its sound stems: dialogue, effects, ambience and music.",
  deliver: "The master checked against the project’s saved delivery spec, then packaged.",
  agent: "Describe an outcome and review the priced plan before anything paid runs.",
  runs: "Every agent run with its dispatch claim, status and accounting.",
  generate: "Single generations, tools and voice from the connected account.",
  recipes: "Saved plans that rerun exactly against this project.",
  builds: "Small tools the agent builds and publishes on the viewer’s own credits.",
  skills: "The tool packs the agent can reach, with scope and cost.",
  models: "The planning model and every generation engine with its real limits.",
  approvals: "Every waiting gate with its live price, inputs and expiry.",
  budget: "Settled spend by engine and person, from the ledger.",
  marketing: "Product, brand and cast, message and format, then variants and output.",
  motion: "A source video recast with your own cast, location and product.",
  swap: "One element replaced; the rest of the shot stays as filmed.",
  shorts: "One video restyled into a set of short clips, each filed into the project.",
  sources: "Your originals, hashed and checked against what the models accept.",
  compare: "Original and result on one clock, split or wiped.",
  history: "Every result, retained in private storage, ready to recreate.",
};

function placeholder(id: PageId): ComponentType<PageBodyProps> {
  function Placeholder() {
    return (
      <div className="pxw-placeholder" data-page-body={id}>
        <Kicker>{pageDef(id).title}</Kicker>
        <p>{COMING[id]}</p>
      </div>
    );
  }
  Placeholder.displayName = `Placeholder(${id})`;
  return Placeholder;
}

/** Built pages; every other id keeps its placeholder or its spec card. */
const BUILT: Partial<Record<PageId, ComponentType<PageBodyProps>>> = {
  rig: RigPage,
  cast: CastPage,
  edit: EditPage,
  takes: TakesPage,
};

/** One component per page, so moving between two spec pages starts each fresh. */
function specPage(id: PageId): ComponentType<PageBodyProps> {
  function Spec(props: PageBodyProps) {
    return <SpecPage {...props} />;
  }
  Spec.displayName = `SpecPage(${id})`;
  return Spec;
}

/** Spec-card pages (03, "Spec-card template") with their working tools. */
const SPEC_BODIES: PageId[] = [
  "brief", "boards", "astra", "deliver",
  "agent", "runs", "recipes", "builds", "skills", "models", "approvals", "budget",
  "marketing",
  "motion", "swap", "sources", "compare", "history",
];

/** Atomik Generate keeps its existing body (with its Tools and Voice groups), inside the shell. */
function GenerateBody({ project }: PageBodyProps) {
  return (
    <div className="pxw-spec pxw-generate" data-page-body="generate">
      <div className="pxw-embed">
        <SpecTool page="generate" tool="generate" project={project} scope={useSession().requestScope ?? null} onProject={() => {}} />
      </div>
    </div>
  );
}

/** Page id → body. Later PRs replace an entry with the real page. */
export const PAGE_BODIES: Record<PageId, ComponentType<PageBodyProps>> = Object.fromEntries(
  (Object.keys(COMING) as PageId[]).map((id) => [id, BUILT[id] ?? (id === "generate" ? GenerateBody : SPEC_BODIES.includes(id) ? specPage(id) : placeholder(id))]),
) as Record<PageId, ComponentType<PageBodyProps>>;
