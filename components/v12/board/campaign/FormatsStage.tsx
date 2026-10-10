"use client";
import { briefOf } from "@/components/graphite/business/own-kit";
import { useAdsActions } from "@/components/graphite/board/ads/use-ads-actions";
import type { BoardCtx } from "@/components/graphite/board/cards/types";
import { CAMPAIGN_FORMATS, formatFits, formatQuote, type CampaignFormat } from "@/lib/v12/campaign";
import { useQuote } from "@/lib/v12/useQuote";
import { Price } from "@/components/v12/ui/Price";
import "../stage-pages.css";
import "./campaign.css";

/**
 * The Formats stage (Campaign; docs/redesign/inventory.md § 10.1; prototype L584): eight skill cards on one even grid, each
 * with an example, a line, and one price for its run. A format is a creative brief of today's catalogue that Make runs, so
 * "Pick" chooses the brief (free, on the board's draft) and the one filled button opens Make with it, where the same price is on
 * Make's own button before anything runs. A format that does not fit the product shows once, dimmed, with its reason; one
 * with no brief or engine behind it cannot be picked. Nothing here spends.
 */
export function FormatsStage({ ctx }: { ctx: BoardCtx }) {
  const project = ctx.project;
  const actions = useAdsActions();
  const brief = briefOf(project);
  const picked = brief.creative?.path === "template" ? brief.creative.templateId : null;
  const product = { name: brief.productName, brand: brief.productBrand ?? "", description: brief.productDescription ?? "" };
  const example = project.assets.find((a) => a.id === brief.productAssetIds[0] && a.kind === "image");
  const canWrite = !ctx.offline && !ctx.readOnly;
  const pickedFormat = CAMPAIGN_FORMATS.find((f) => f.templateId && f.templateId === picked) ?? null;
  const make = () => { if (picked) { const refused = actions.makeInMake(picked); if (refused) ctx.toast(refused); } };

  return (
    <div className="v12-sp v12-cp v12-cp-formats" data-testid="v12-formats-stage">
      <header className="v12-cp-bar">
        <div>
          <h2 className="v12-sp-title">Formats</h2>
          <p className="v12-sp-why" data-testid="v12-formats-line">{pickedFormat ? `${pickedFormat.title} · Make shows its price before anything runs.` : "Pick a format. Make runs it, and shows its price before anything runs."}</p>
        </div>
        <button type="button" className="v12-sp-btn v12-sp-primary" disabled={!canWrite || !pickedFormat} onClick={make} data-testid="v12-formats-make">
          {pickedFormat ? <>Make · <FormatPrice format={pickedFormat} /></> : "Pick a format"}
        </button>
      </header>
      <div className="v12-cp-grid" data-testid="v12-formats-grid">
        {CAMPAIGN_FORMATS.map((format) => {
          const fit = formatFits(format, product);
          const off = format.notBuilt ?? (fit.fits ? null : fit.why);
          const on = Boolean(format.templateId) && format.templateId === picked;
          return (
            <article key={format.id} className="v12-sp-card v12-cp-skill" data-state={off ? "off" : on ? "picked" : "open"} data-testid="v12-format" data-format={format.id} aria-disabled={off ? true : undefined}>
              {example && !off ? (
                // eslint-disable-next-line @next/next/no-img-element -- the product's own real photo
                <img className="v12-cp-example" src={example.url} alt="" loading="lazy" />
              ) : <span className="v12-cp-example" aria-hidden="true" />}
              <span className="v12-sp-eyebrow">Skill</span>
              <h3 className="v12-sp-title">{format.title}</h3>
              <p className="v12-cp-line">{off ?? format.line}</p>
              {format.person && !off ? <p className="v12-sp-why" data-testid="v12-format-consent">A real person’s face needs a consent record. A generated presenter is an adult.</p> : null}
              <div className="v12-cp-foot">
                {off ? <span className="v12-sp-state" data-testid="v12-format-state">{format.notBuilt ? "Not built yet" : "Doesn’t apply"}</span> : (
                  <>
                    <span className="v12-sp-state" data-testid="v12-format-state">{on ? "Picked" : "One run"} · <FormatPrice format={format} /></span>
                    <button type="button" className="v12-sp-btn" aria-pressed={on} disabled={!canWrite || on} onClick={() => actions.chooseBrief(format.templateId!)} data-testid="v12-format-pick">{on ? "Picked" : "Pick"}</button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

/** A format's one price: the server's quote at Make's own settings, else "quoted" with why. */
export function FormatPrice({ format, ratio }: { format: CampaignFormat; ratio?: string }) {
  const asked = formatQuote(format, ratio);
  const quote = useQuote("source" in asked ? asked.source : null);
  return "source" in asked ? <Price quote={quote} /> : <Price quote={null} reason={asked.reason} />;
}
