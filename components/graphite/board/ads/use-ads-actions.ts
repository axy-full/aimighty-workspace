"use client";
import { useCallback, useRef } from "react";
import { useBoard } from "../BoardContext";
import { useShell } from "@/lib/shell/state";
import { sendGenPreset } from "@/lib/shell/gen-preset";
import { sendReference } from "@/lib/shell/reference-inbox";
import { briefForGen, mergeHooks, chooseProduct, withTemplate } from "@/lib/shell/business-own";
import { CREATIVE_TEMPLATES, EMPTY_BRAND_KIT } from "@/lib/workbench/moleculr-creative";
import { EMPTY_REFERENCE_AD } from "@/lib/workbench/reference-ad";
import { applyReferenceAdAnalysis } from "@/lib/workbench/reference-ad-analysis";
import { changeBrief, briefOf, useLatest } from "../../business/own-kit";
import { approveBrand, approveProduct, brandHome, readBrandPage, readProductPage, siteUrl } from "./reads";
import { openDesigner, openDialog, openPanel, patchSession, readSession, togglePicked, type PanelId } from "./ads-session";
import { useRiggedEditor } from "./use-ads-editor";

/*
 * What the Ads board's cards do. Every one runs the code the old Business pages ran (own-kit's changeBrief, the
 * extract routes, briefForGen, the run dialog), on the board's one draft (the Rig's). Free actions apply at once with
 * Undo; a paid one only opens the place that prices it: the agent's run dialog (which quotes, then reserves up to the
 * estimate) or Make (which shows its price on its button). Nothing here approves spending.
 */
export function useAdsActions() {
  const ctx = useBoard();
  const shell = useShell();
  const editor = useRiggedEditor(ctx.rig);
  const pid = ctx.project.id;
  const latest = useLatest(ctx);
  const reading = useRef<AbortController | null>(null);

  const say = useCallback((text: string, undo?: { label: string; run: () => void }) => latest.current.toast(text, undo), [latest]);
  const brief = () => briefOf(latest.current.rig.project ?? ctx.project);

  /** Free: read the product page and the brand's home page. Nothing from either is used until it is approved. */
  const readSite = useCallback(async (raw: string): Promise<string | null> => {
    const checked = siteUrl(raw);
    if (!checked.ok) return checked.reason;
    const { url } = checked;
    const home = brandHome(url);
    const scope = latest.current.scope;
    reading.current?.abort();
    const abort = new AbortController();
    reading.current = abort;
    patchSession(pid, { brand: { url: home, status: "reading" }, product: { url: url.href, status: "reading" } });
    try {
      if (!(await latest.current.rig.save())) throw new Error("The project is not saved yet. Try again.");
      /* The addresses are the person's own input: kept on the brief, so the cards and the Edit panels carry them. */
      changeBrief(editor, (b) => ({ ...b, productUrl: b.productUrl.trim() ? b.productUrl : url.href, brandKit: { ...(b.brandKit ?? EMPTY_BRAND_KIT), website: b.brandKit?.website?.trim() ? b.brandKit.website : home } }));
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "The site could not be read.";
      patchSession(pid, { brand: { url: home, status: "failed", error }, product: { url: url.href, status: "failed", error } });
      return null;
    }
    const [product, brand] = await Promise.allSettled([readProductPage(scope, pid, url.href, abort.signal), readBrandPage(scope, pid, home, abort.signal)]);
    if (abort.signal.aborted) return null;
    const failed = (r: PromiseRejectedResult) => (r.reason instanceof Error ? r.reason.message : "The page could not be read.");
    patchSession(pid, {
      product: product.status === "fulfilled" ? { url: url.href, status: "ready", result: product.value } : { url: url.href, status: "failed", error: failed(product) },
      brand: brand.status === "fulfilled" ? { url: home, status: "ready", result: brand.value } : { url: home, status: "failed", error: failed(brand) },
    });
    return null;
  }, [editor, latest, pid]);

  const tryAgain = useCallback((url: string) => { void readSite(url); }, [readSite]);

  const approveBrandRead = useCallback(() => {
    const read = readSession(pid).brand;
    if (read?.status !== "ready" || !read.result) return;
    const out = approveBrand(brief().brandKit, read.result);
    if ("error" in out) { say(out.error); return; }
    const before = brief().brandKit;
    changeBrief(editor, (b) => ({ ...b, brandKit: out.kit }));
    patchSession(pid, { brand: null });
    void latest.current.rig.save();
    say("Brand kit approved", { label: "The brand kit is back as it was", run: () => { changeBrief(editor, (b) => ({ ...b, brandKit: before })); } });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, latest, pid, say]);

  const approveProductRead = useCallback(() => {
    const read = readSession(pid).product;
    if (read?.status !== "ready" || !read.result) return;
    const before = brief();
    const out = approveProduct(before, read.result, crypto.randomUUID());
    if ("error" in out) { say(out.error); return; }
    changeBrief(editor, () => out.brief);
    patchSession(pid, { product: null });
    void latest.current.rig.save();
    say("Product facts approved", { label: "The product facts are back as they were", run: () => { changeBrief(editor, () => before); } });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, pid, say]);

  const edit = useCallback((panel: PanelId) => openPanel(pid, panel), [pid]);

  /** The agent's reviewed direction of the reference video goes on the brief, as edited by the person on the panel. */
  const approveReference = useCallback(() => {
    const agent = readSession(pid).agent;
    const analysis = agent?.analysis;
    const project = latest.current.rig.project;
    if (!analysis || !project) return;
    try {
      const before = brief().referenceAd;
      const next = applyReferenceAdAnalysis(project, before ?? EMPTY_REFERENCE_AD, analysis);
      changeBrief(editor, (b) => ({ ...b, referenceAd: next }));
      void latest.current.rig.save();
      say("Reference direction approved. Video briefs in Format carry it.", { label: "The reference is back as it was", run: () => { changeBrief(editor, (b) => ({ ...b, referenceAd: before })); } });
    } catch (cause) { say(cause instanceof Error ? cause.message : "The direction could not be applied."); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, pid, say]);

  const pick = useCallback((hook: string) => togglePicked(pid, hook), [pid]);

  /** The agent's proposed lines join the list (free): never past twelve, none twice. */
  const addHooks = useCallback((proposed: readonly string[]) => {
    const before = brief().hooks;
    const merged = mergeHooks(before, proposed);
    changeBrief(editor, (b) => ({ ...b, hooks: merged.hooks }));
    void latest.current.rig.save();
    say(merged.added ? `${merged.added} ${merged.added === 1 ? "hook" : "hooks"} added${merged.skipped ? ` · ${merged.skipped} did not fit in twelve` : ""}` : "Those hooks are on the list already.",
      merged.added ? { label: "The hooks are back as they were", run: () => { changeBrief(editor, (b) => ({ ...b, hooks: before })); } } : undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, latest, say]);

  /** Picks the brief on Format (free), so the one Make receives is this one. */
  const chooseBrief = useCallback((templateId: string) => {
    const template = CREATIVE_TEMPLATES.find((t) => t.id === templateId);
    if (!template) return;
    changeBrief(editor, (b) => withTemplate(b, template));
  }, [editor]);

  /**
   * "Make in Make": the brief's prompt, its frame and the product's stills go to Make, which shows its price on its
   * button before anything runs. A hook picked on the Hooks card rides with it.
   */
  const makeInMake = useCallback((templateId: string, only?: { hook?: string; ratio?: string }): string | null => {
    const template = CREATIVE_TEMPLATES.find((t) => t.id === templateId);
    const project = latest.current.rig.project;
    if (!template || !project) return "Open a project first.";
    const asked = withTemplate(briefOf(project), template);
    /* The Variants grid names the hook and the size of its cell; the Formats card uses the hook picked on the Hooks card. */
    const hook = only?.hook ?? readSession(pid).picked.find((h) => asked.hooks.includes(h)) ?? null;
    const ready = briefForGen(project, asked, hook);
    if ("problem" in ready) return ready.problem;
    changeBrief(editor, () => asked);
    void latest.current.rig.save();
    sendGenPreset({ prompt: ready.prompt, type: ready.type, note: ready.note, billing: "workspace", picks: { ratio: only?.ratio ?? ready.ratio } });
    for (const ref of ready.references) sendReference(ref);
    shell.openMake(ready.type);
    return null;
  }, [editor, latest, pid, shell]);

  const switchProduct = useCallback((id: string) => {
    const next = chooseProduct(brief(), id);
    if (!next.brief) { say(next.problem); return; }
    changeBrief(editor, () => next.brief);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, say]);

  return { editor, readSite, tryAgain, approveBrandRead, approveProductRead, approveReference, edit, pick, addHooks, chooseBrief, makeInMake, switchProduct, openDialog: (d: "hooks" | "reference") => openDialog(pid, d), openDesigner: () => openDesigner(pid, true), say };
}
