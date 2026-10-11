"use client";
import { briefOf } from "@/components/graphite/business/own-kit";
import { useAdsActions } from "@/components/graphite/board/ads/use-ads-actions";
import type { BoardCtx } from "@/components/graphite/board/cards/types";
import { brandKitMade } from "@/lib/shell/business-own";
import { LEGAL_WHY, mandatories } from "@/lib/v12/campaign";
import { Swatches } from "./ProductStage";
import "../stage-pages.css";
import "./campaign.css";

/**
 * The Look stage (Campaign; docs/redesign/inventory.md § 10.1; prototype L583): the moodboard and the brand's mandatories.
 * The brand's look is its kit (colours, typefaces, tone, logo), read through the Product stage or written by hand with Edit.
 * Mandatories have no store of their own: each row is answered from the brand kit and the product's photos, and the legal
 * line, which has nowhere to live yet, says so. Nothing here spends.
 */
export function LookStage({ ctx }: { ctx: BoardCtx }) {
  const project = ctx.project;
  const actions = useAdsActions();
  const brief = briefOf(project);
  const kit = brandKitMade(brief.brandKit) ? brief.brandKit : null;
  const boards = project.nodes.filter((n) => n.type === "moodboard");
  const rows = mandatories(kit, brief.productAssetIds.length);
  const logo = kit?.logoAssetId ? project.assets.find((a) => a.id === kit.logoAssetId) : undefined;

  return (
    <div className="v12-sp v12-cp v12-cp-look" data-testid="v12-look-stage">
      <section className="v12-sp-card" aria-labelledby="v12-lk-mood-h" data-testid="v12-look-mood">
        <header className="v12-sp-head"><span className="v12-sp-eyebrow">Moodboard</span><span className="v12-sp-state">{boards.length ? `${boards.length} ${boards.length === 1 ? "board" : "boards"}` : "None yet"}</span></header>
        <h2 className="v12-sp-title" id="v12-lk-mood-h">{boards[0]?.title || "No moodboard yet"}</h2>
        {boards.length ? (
          <dl className="v12-sp-lines">{boards.slice(0, 4).map((b) => <div className="v12-sp-line" key={b.id}><dt>{b.title}</dt><dd>{b.text?.trim() || "No words yet."}</dd></div>)}</dl>
        ) : <p className="v12-sp-why">Drop references from the Library, or ask Atomik to gather a mood from the brief.</p>}
        <div className="v12-sp-acts">
          <button type="button" className="v12-sp-btn" onClick={() => ctx.askAtomik("Gather a mood for the campaign from the brief: ")} data-testid="v12-look-ask">Ask Atomik</button>
        </div>
      </section>

      <section className="v12-sp-card" aria-labelledby="v12-lk-brand-h" data-testid="v12-look-brand">
        <header className="v12-sp-head"><span className="v12-sp-eyebrow">Brand look</span><span className="v12-sp-state">{kit ? "Approved" : "No brand kit yet"}</span></header>
        <h2 className="v12-sp-title" id="v12-lk-brand-h">{kit?.name?.trim() || "Brand kit"}</h2>
        <dl className="v12-sp-lines">
          <div className="v12-sp-line"><dt>Colours</dt><dd>{kit?.colors?.length ? <Swatches colours={kit.colors} /> : "Not read yet."}</dd></div>
          <div className="v12-sp-line"><dt>Type</dt><dd>{kit?.fontFamilies?.length ? kit.fontFamilies.join(" · ") : kit ? "System" : "Not read yet."}</dd></div>
          <div className="v12-sp-line"><dt>Tone</dt><dd>{kit?.tagline?.trim() || kit?.voice?.trim() || "Not written yet."}</dd></div>
          <div className="v12-sp-line"><dt>Logo</dt><dd>{logo ? <>{/* eslint-disable-next-line @next/next/no-img-element -- the project's own original */}<img className="v12-cp-logo" src={logo.url} alt="Logo" /></> : "Not set."}</dd></div>
        </dl>
        <div className="v12-sp-acts"><button type="button" className="v12-sp-btn" onClick={() => actions.edit("brand")} data-testid="v12-look-edit">{kit ? "Edit" : "Write it by hand"}</button></div>
      </section>

      <section className="v12-sp-card" aria-labelledby="v12-lk-mand-h" data-testid="v12-look-mandatories">
        <header className="v12-sp-head"><h2 className="v12-sp-title" id="v12-lk-mand-h">Brand mandatories{kit?.name?.trim() ? ` · ${kit.name.trim()}` : ""}</h2><span className="v12-sp-state">{rows.filter((r) => !r.ok).length} to set</span></header>
        <dl className="v12-sp-lines">
          {rows.map((r) => <div className="v12-sp-line" key={r.label} data-ok={r.ok || undefined} data-testid="v12-look-mandatory"><dt>{r.label}</dt><dd>{r.value}{r.ok ? <span className="v12-sp-ok" aria-hidden="true"> ✓</span> : null}</dd></div>)}
        </dl>
        <p className="v12-sp-why" data-testid="v12-look-mandatories-why">Read from the brand kit and the product’s photos. {LEGAL_WHY}</p>
      </section>
    </div>
  );
}
