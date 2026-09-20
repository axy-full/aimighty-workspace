"use client";
import type { ComponentType } from "react";
import type { Project } from "@/lib/workbench/studio";
import { pageDef } from "@/lib/workspace/pages";
import type { AppState, MobileSheetId } from "@/lib/workspace/types";
import { KIND_LABEL } from "../../inspector/registry";
import { AtomikSheet } from "./AtomikSheet";
import { InspectorSheet } from "./InspectorSheet";
import { LibrarySheet } from "./LibrarySheet";
import { SearchSheet } from "./SearchSheet";

/**
 * The four sheets, one seam (05-mobile, "Sheets"). Wave M-A shipped the chrome
 * (components/workspace/mobile/MobileSheet.tsx) with Search wired through it;
 * wave M-C adds `inspector`, `atomik` and `library` by registering them here
 * and writing nothing new about the chrome — 24px top radius,
 * rgba(5,6,8,.55) scrim, 36×4 grabber, 34px close, 26px bottom padding, 88%
 * max height and the dock behind the scrim are all the primitive's.
 */
export type MobileSheetBodyProps = {
  scope: string;
  project: Project | null;
  /** Generate the selected shot, when a page body owns one (the desktop seam). */
  onGenerate?: () => void;
};

export type MobileSheetDef = {
  /** 17px title, and the 12px line under it. Derived, never a fixture. */
  title: string;
  sub?: (ctx: { project: Project | null; state: AppState }) => string;
  /** The sheet carries the Atomik ring in its header. */
  ring?: boolean;
  Body?: ComponentType<MobileSheetBodyProps>;
};

export const MOBILE_SHEETS: Record<MobileSheetId, MobileSheetDef> = {
  search: { title: "Search", sub: () => "Suites, stages, plans and shots", Body: SearchSheet },
  /* The kind pill the desktop Inspector shows, as the sheet's own line. */
  inspector: { title: "Inspector", sub: ({ state }) => KIND_LABEL[state.selKind], Body: InspectorSheet },
  atomik: { title: "Atomik", ring: true, sub: ({ state }) => pageDef(state.page).title, Body: AtomikSheet },
  library: { title: "Library", sub: ({ state }) => pageDef(state.page).title, Body: LibrarySheet },
};

/** What an unregistered sheet would say. All four are registered now. */
export const SHEET_PENDING: Record<MobileSheetId, string> = {
  search: "",
  inspector: "",
  atomik: "",
  library: "",
};
