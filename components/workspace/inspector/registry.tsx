"use client";
import type { ComponentType } from "react";
import type { Project } from "@/lib/workbench/studio";
import { getSuite, pageDef } from "@/lib/workspace/pages";
import type { AppState, SelKind } from "@/lib/workspace/types";
import { RigInspector } from "../rig/RigInspector";
import { specFor } from "@/lib/workspace/spec-cards";
import { SpecInspector } from "../spec/SpecInspector";
import { Kicker } from "../ui";
import { CastInspector } from "./CastInspector";
import { TakeInspector } from "./TakeInspector";

export type InspectorBodyProps = { state: AppState; scope: string; project: Project | null };

export const KIND_LABEL: Record<SelKind, string> = { shot: "Scene", take: "Asset", cast: "Identity", page: "Stage" };

const NOTE: Record<SelKind, string> = {
  shot: "Shot controls, inputs and versions appear here when a shot is selected.",
  take: "Asset details, settled cost or integrity, and versions appear here.",
  cast: "The locked identity, its consistency and its references appear here.",
  page: "This page’s specification and its Atomik plan appear here.",
};

function Placeholder({ state }: InspectorBodyProps) {
  const def = pageDef(state.page);
  return (
    <div data-inspector-body={state.selKind}>
      <Kicker>Output</Kicker>
      <div className="pxw-preview" style={{ marginTop: 10 }} aria-hidden="true" />
      <div className="pxw-inspector-subject">{def.title}</div>
      <div className="pxw-inspector-sub">{getSuite(state.suite).name}</div>
      <p className="pxw-inspector-note">{NOTE[state.selKind]}</p>
    </div>
  );
}

/** Spec-card pages show their specification and plan; other page-kind pages keep the placeholder. */
function PageInspector(props: InspectorBodyProps) {
  return specFor(props.state.page) ? <SpecInspector {...props} /> : <Placeholder {...props} />;
}

/** Selection kind → Inspector body. Later PRs replace an entry. */
export const INSPECTOR_BODIES: Record<SelKind, ComponentType<InspectorBodyProps>> = {
  shot: RigInspector,
  take: TakeInspector,
  cast: CastInspector,
  page: PageInspector,
};
