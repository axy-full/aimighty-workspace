"use client";
import { useShell } from "@/lib/shell/state";
import { briefOf } from "@/components/graphite/business/own-kit";
import { useAdsActions } from "@/components/graphite/board/ads/use-ads-actions";
import type { BoardCtx } from "@/components/graphite/board/cards/types";
import { briefHooks, OWN_LIMITS } from "@/lib/shell/business-own";
import { CAMPAIGN_FORMATS, FIRST_ROW_WHY, VARIANT_COLUMNS, VARIANTS_NOTE, VERSIONS_WHY, formatQuote, templateOf, type CampaignFormat } from "@/lib/v12/campaign";
import { useQuote } from "@/lib/v12/useQuote";
import { Price } from "@/components/v12/ui/Price";
import "../stage-pages.css";
import "./campaign.css";

/**
 * The Variants stage (Campaign; docs/redesign/inventory.md § 10.1; prototype L585): hooks down the side, the sizes across,
 * and a cell for each pair. A cell opens Make with that hook and that size on the picked format's brief; its price is the
 * server's quote at Make's own settings (the same figure Make's button shows), or "quoted" where no quote covers a still.
 * Nothing runs from here: Make asks, and a person approves there. Versions of an approved ad are not built.
 */
export function VariantsStage({ ctx }: { ctx: BoardCtx }) {
  const shell = useShell();
  const actions = useAdsActions();
  const brief = briefOf(ctx.project);
  const hooks = briefHooks(brief);
  const picked = brief.creative?.path === "template" ? brief.creative.templateId ?? null : null;
  const template = picked ? templateOf({ templateId: picked } as CampaignFormat) : null;
  const format: CampaignFormat | null = template ? CAMPAIGN_FORMATS.find((f) => f.templateId === picked) ?? { id: picked!, title: template.name, line: "", templateId: picked, person: false, notBuilt: null } : null;
  const canWrite = !ctx.offline && !ctx.readOnly;
  /* One quote per size: every hook of a size costs the same. */
  const asks = VARIANT_COLUMNS.map((c) => (format ? formatQuote(format, c.ratio) : null));
  const q0 = useQuote(asks[0] && "source" in asks[0] ? asks[0].source : null);
  const q1 = useQuote(asks[1] && "source" in asks[1] ? asks[1].source : null);
  const q2 = useQuote(asks[2] && "source" in asks[2] ? asks[2].source : null);
  const quotes = [q0, q1, q2];

  const cellPrice = (i: number) => {
    const a = asks[i];
    if (!format || !a) return <span className="v12-sp-state">Make</span>;
    return "source" in a ? <Price quote={quotes[i]} /> : <Price quote={null} reason={a.reason} />;
  };
  const makeCell = (hook: string, ratio: string) => {
    if (!picked) return;
    const refused = actions.makeInMake(picked, { hook, ratio });
    if (refused) ctx.toast(refused);
  };

  return (
    <div className="v12-sp v12-cp v12-cp-variants" data-testid="v12-variants-stage">
      <section className="v12-sp-card" aria-labelledby="v12-vr-h" data-testid="v12-variants-card">
        <header className="v12-sp-head"><h2 className="v12-sp-title" id="v12-vr-h">Variants · hooks × formats</h2>
          <span className="v12-sp-state" data-testid="v12-variants-state">{!hooks.length ? "No hooks yet" : !format ? "Pick a format first" : `${format.title} · ${hooks.length} ${hooks.length === 1 ? "hook" : "hooks"}`}</span></header>
        {!format ? (
          <p className="v12-sp-why" data-testid="v12-variants-needs-format">The grid makes each hook at each size, on one format. <button type="button" className="v12-cp-link" onClick={() => shell.setScreenParams({ stage: "formats" }, "push")} data-testid="v12-variants-go-formats">Pick a format</button></p>
        ) : null}
        {!hooks.length ? (
          <p className="v12-sp-why" data-testid="v12-variants-needs-hooks">Opening hooks are written against the brief. Add your own, or ask Atomik to write some.</p>
        ) : (
          <div className="v12-cp-vtable" role="table" aria-label="Hooks by size">
            <div className="v12-cp-vrow v12-cp-vhead" role="row">
              <span role="columnheader" />
              {VARIANT_COLUMNS.map((c) => <span key={c.id} role="columnheader">{c.label}</span>)}
            </div>
            {hooks.map((hook) => (
              <div className="v12-cp-vrow" role="row" key={hook} data-testid="v12-variant-row">
                <span role="rowheader" className="v12-cp-hook">{hook}</span>
                {VARIANT_COLUMNS.map((c, i) => (
                  <button key={c.id} type="button" role="cell" className="v12-cp-cell" disabled={!canWrite || !format || Boolean(format.notBuilt)} onClick={() => makeCell(hook, c.ratio)} data-testid="v12-variant-cell" data-ratio={c.ratio}
                    title={format ? "Make this cell in Make" : "Pick a format first"}>
                    <span className="v12-ds-dot" aria-hidden="true" />
                    {cellPrice(i)}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        <dl className="v12-sp-lines">
          {VARIANTS_NOTE.map(([k, v]) => <div className="v12-sp-line" key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          <div className="v12-sp-line"><dt>Versions</dt><dd data-testid="v12-variants-versions">{VERSIONS_WHY}</dd></div>
        </dl>
        <div className="v12-sp-acts">
          <button type="button" className="v12-sp-btn v12-sp-primary" disabled={!canWrite || hooks.length >= OWN_LIMITS.hooks} onClick={() => actions.edit("hooks")} data-testid="v12-variants-add-hook">Add a hook</button>
          <button type="button" className="v12-sp-btn" disabled title={FIRST_ROW_WHY} data-testid="v12-variants-first-row">Make the first row</button>
        </div>
        <p className="v12-sp-why">{FIRST_ROW_WHY}</p>
      </section>
    </div>
  );
}
