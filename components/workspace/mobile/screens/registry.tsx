"use client";
import type { ComponentType } from "react";
import type { Project } from "@/lib/workbench/studio";
import type { PageId } from "@/lib/workspace/types";
import type { MobilePrimary } from "../MobileActionBar";

/**
 * The phone's page templates — the seam wave M-B fills (05-mobile, "Page
 * templates": shot list, flow, cards, rows, accordion, form).
 *
 * A page registers a body and, when its primary is its own (Generate on Rig,
 * Upload on Takes, Add cast on Cast), the primary the action bar should pin.
 * Registering a page changes nothing about the shell, the header, the dock,
 * the action bar or the sheets: this record is the whole contract.
 */
export type MobilePageProps = {
  page: PageId;
  project: Project | null;
  scope: string;
};

export type MobilePageContext = MobilePageProps & {
  /** Generate the selected shot, when something owns it (the desktop seam). */
  onGenerate?: () => void;
  /** The live quote for Generate and anything blocking it (PageHeader's GenerateStatus). */
  quote?: string | null;
  blocked?: string | null;
};

export type MobilePageDef = {
  Body: ComponentType<MobilePageProps>;
  /** Null means "this page has no primary of its own" and the stage plan's is used. */
  primary?: (ctx: MobilePageContext) => MobilePrimary | null;
};

export const MOBILE_PAGES: Partial<Record<PageId, MobilePageDef>> = {};
