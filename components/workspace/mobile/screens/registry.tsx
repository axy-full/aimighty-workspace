"use client";
import type { ComponentType } from "react";
import type { Project } from "@/lib/workbench/studio";
import { MOBILE_TEMPLATES, templateFor, type MobileTemplate } from "@/lib/workspace/mobile-templates";
import type { PageId } from "@/lib/workspace/types";
import type { MobilePrimary } from "../MobileActionBar";
import { AccordionPage } from "../pages/AccordionPage";
import { CastCardsPage, TakesCardsPage } from "../pages/CardsPages";
import { EditSoundPage } from "../pages/EditSoundPage";
import { FormPage } from "../pages/FormPage";
import { RigTemplate } from "../pages/RigTemplate";
import { RowsPage } from "../pages/RowsPage";

/**
 * The phone's page templates — the seam wave M-B fills (05-mobile, "Page
 * templates": shot list, flow, cards, rows, accordion, form).
 *
 * A page registers a body and, when its primary is its own (Generate on Rig,
 * Upload on Takes, Add cast on Cast), the primary the action bar should pin.
 * Registering a page changes nothing about the shell, the header, the dock,
 * the action bar or the sheets: this record is the whole contract.
 *
 * Which template a page uses is decided once, in lib/workspace/mobile-templates
 * (`MOBILE_TEMPLATES`), so the mapping is data a test can read rather than a
 * shape spread across files. Rig registers one body that switches between the
 * shot list and the flow on `rigView`, which is the same state the desktop
 * page's segmented control sets.
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

/** One component per template; a page's entry is chosen by MOBILE_TEMPLATES. */
const BODIES: Record<MobileTemplate, ComponentType<MobilePageProps>> = {
  shots: RigTemplate,
  flow: RigTemplate,
  cards: CastCardsPage,
  rows: RowsPage,
  accordion: AccordionPage,
  form: FormPage,
  edit: EditSoundPage,
};

/**
 * Rig's Generate: the shell already derives it from the same seams the desktop
 * header reads, so the only thing registered here is the reason it cannot run,
 * which must be a sentence rather than a dead button.
 */
const rigPrimary = (ctx: MobilePageContext): MobilePrimary | null => ({
  label: "Generate",
  cost: ctx.blocked ? null : ctx.quote ?? null,
  blocked: ctx.onGenerate ? ctx.blocked ?? null : "Open a project and choose a shot to generate.",
  run: () => ctx.onGenerate?.(),
});

export const MOBILE_PAGES: Partial<Record<PageId, MobilePageDef>> = Object.fromEntries(
  (Object.keys(MOBILE_TEMPLATES) as PageId[]).map((page) => {
    const Body = page === "takes" ? TakesCardsPage : BODIES[MOBILE_TEMPLATES[page]];
    return [page, page === "rig" ? { Body, primary: rigPrimary } : { Body }];
  }),
) as Partial<Record<PageId, MobilePageDef>>;

export { templateFor };
