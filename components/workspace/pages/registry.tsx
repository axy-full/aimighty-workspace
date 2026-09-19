"use client";
import type { ComponentType } from "react";
import type { Project } from "@/lib/workbench/studio";
import { pageDef } from "@/lib/workspace/pages";
import type { PageId } from "@/lib/workspace/types";
import { RigPage } from "../rig/RigPage";
import { Kicker } from "../ui";

/** Everything a page body receives from the shell. */
export type PageBodyProps = {
  page: PageId;
  project: Project | null;
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

/** Page id → body. Later PRs replace an entry with the real page. */
export const PAGE_BODIES: Record<PageId, ComponentType<PageBodyProps>> = {
  ...(Object.fromEntries((Object.keys(COMING) as PageId[]).map((id) => [id, placeholder(id)])) as Record<PageId, ComponentType<PageBodyProps>>),
  rig: RigPage,
};
