"use client";
import type { ComponentType } from "react";
import type { Project } from "@/lib/workbench/studio";
import type { MobileSheetId } from "@/lib/workspace/types";
import { SearchSheet } from "./SearchSheet";

/**
 * The four sheets, one seam (05-mobile, "Sheets"). Wave M-A ships the chrome
 * (components/workspace/mobile/MobileSheet.tsx) with Search wired through it;
 * wave M-C adds `inspector`, `atomik` and `library` by registering them here
 * and writing nothing new about the chrome. A sheet that is not registered
 * yet opens its chrome and says so rather than pretending to hold content.
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
  sub?: (project: Project | null) => string;
  /** The sheet carries the Atomik ring in its header. */
  ring?: boolean;
  Body?: ComponentType<MobileSheetBodyProps>;
};

export const MOBILE_SHEETS: Record<MobileSheetId, MobileSheetDef> = {
  search: { title: "Search", sub: () => "Suites, stages, plans and shots", Body: SearchSheet },
  inspector: { title: "Inspector" },
  atomik: { title: "Atomik", ring: true },
  library: { title: "Library" },
};

/** What an unregistered sheet says. Honest, and one line — never a skeleton. */
export const SHEET_PENDING: Record<MobileSheetId, string> = {
  search: "",
  inspector: "The Inspector opens on the phone with the page templates.",
  atomik: "Atomik’s plan, steps and gate open on the phone with the agent sheet.",
  library: "Tools and media open on the phone with the library sheet.",
};
