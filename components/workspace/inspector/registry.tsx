"use client";
import type { ComponentType } from "react";
import { getSuite, pageDef } from "@/lib/workspace/pages";
import type { AppState, SelKind } from "@/lib/workspace/types";
import { Kicker } from "../ui";

export type InspectorBodyProps = { state: AppState };

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

/** Selection kind → Inspector body. Later PRs replace an entry. */
export const INSPECTOR_BODIES: Record<SelKind, ComponentType<InspectorBodyProps>> = {
  shot: Placeholder,
  take: Placeholder,
  cast: Placeholder,
  page: Placeholder,
};
