"use client";
import type { GenPreset } from "@/lib/shell/assets";
import {
  ACCOUNT_RETIRED, ALTERNATIVE_LABEL, HISTORY_KEPT, OWNER_RUNS, alternativePrice, ownerRunEyebrow, type OwnerRunSurface,
} from "@/lib/shell/connected-capability";
import { useStudioAlternative } from "@/lib/shell/use-studio-alternative";
import { useShell } from "@/lib/shell/state";
import { Glyph } from "./icons";

/**
 * Gen, opened on an output (and optionally a prompt and the engine a card
 * priced), on this workspace's credits: the preset goes through Gen's one
 * letterbox (lib/shell/gen-preset), then Make opens and applies it.
 */
export function openGenOn(shell: ReturnType<typeof useShell>, preset: GenPreset) {
  shell.openMake({ ...preset, billing: "workspace" });
}

/**
 * What everyone sees where the connected Higgsfield account used to run: the
 * sign-in is retired (lib/higgsfield-consumer/retired.ts), so the card says
 * what ran there, that the connected account is no longer used and that past
 * results stay in the Library — and, where a Studio engine makes the same
 * kind of thing, that engine on this workspace's credits at its price, with
 * the way into Gen. One card, no connect prompt, nothing read from the
 * account, and no vendor name. `page` stands in for a whole page; without it
 * the card sits inside a page that still works (Cast). A surface with no
 * entry (one that was removed, like Business › Ads) draws nothing.
 */
export function OwnerRunCard({ surface, scope, aspect, tools, page = false }: {
  surface: OwnerRunSurface; scope: string; aspect?: string | null; tools?: readonly string[]; page?: boolean;
}) {
  const shell = useShell();
  const run = (OWNER_RUNS as Partial<typeof OWNER_RUNS>)[surface];
  const alt = run?.alternative ?? null;
  const studio = useStudioAlternative(alt ? scope : null, alt?.type ?? null, aspect);
  const priced = studio.model ? alternativePrice(studio.model.label, studio.price) : null;
  const title = ACCOUNT_RETIRED;
  if (!run) return null;
  const card = (
    <section className="gx-gen-card gx-owner-run" aria-label={title} data-testid={`owner-run-${surface}`} data-section={surface === "cast" ? "soul" : undefined}>
      <span className="gx-owner-run-eyebrow" data-functional-label=""><Glyph name="key" size={13} className="gx-glyph" />{ownerRunEyebrow(surface, tools)}</span>
      <h2 className="gx-workflow-title" data-testid={`owner-run-${surface}-title`}>{title}</h2>
      <p className="gx-owner-run-line">{run.line} {HISTORY_KEPT}</p>
      {alt ? (
        <div className="gx-owner-run-alt" data-testid={`owner-run-${surface}-alt`}>
          <span className="gx-owner-run-label" data-functional-label="">{ALTERNATIVE_LABEL}</span>
          <span className="gx-owner-run-what">{alt.what}</span>
          {studio.status === "error" ? (
            <div className="gx-retry" role="alert" data-testid={`owner-run-${surface}-price`}>
              <span className="gx-gen-error">The price could not be read.</span>
              <button type="button" className="gx-hbtn" onClick={studio.retry}>Try again</button>
            </div>
          ) : studio.status === "loading" ? (
            <span className="gx-owner-run-price" aria-busy="true" data-testid={`owner-run-${surface}-price`}><i className="gx-sheet-price-skel" aria-hidden="true" />Pricing…</span>
          ) : (
            <span className="gx-owner-run-price" data-testid={`owner-run-${surface}-price`} title={studio.price?.title}>
              {priced ?? (studio.model ? `${studio.model.label} · priced on Generate` : "No Studio engine is connected for this output.")}
            </span>
          )}
          {studio.status !== "ready" || studio.model ? (
            <div className="gx-owner-run-actions">
              <button type="button" className="gx-primary" data-testid={`owner-run-${surface}-gen`}
                onClick={() => openGenOn(shell, { prompt: "", type: alt.type, ...(studio.model ? { model: studio.model.id } : {}) })}>{alt.action}</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
  return page ? <div className="gx-owner-run-page gx-enter" data-testid={`${surface}-owner-run`}>{card}</div> : card;
}
