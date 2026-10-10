"use client";
import { useMemo, useState } from "react";
import { briefOf, changeBrief, importToDraft, refreshLibrary } from "@/components/graphite/business/own-kit";
import { useAdsActions } from "@/components/graphite/board/ads/use-ads-actions";
import { useAdsSession } from "@/components/graphite/board/ads/ads-session";
import type { BoardCtx } from "@/components/graphite/board/cards/types";
import { OWN_LIMITS } from "@/lib/shell/business-own";
import { EMPTY_BRAND_KIT } from "@/lib/workbench/moleculr-creative";
import { hostOfUrl, productReview } from "@/lib/v12/campaign";
import "../stage-pages.css";
import "./campaign.css";

/**
 * The Product stage (Campaign; docs/redesign/inventory.md § 10.1; prototype L582): paste a product page link and Particl
 * reads its name, words, colours, logo and packshots through today's two free reads (the extract-product and extract-brand
 * routes, components/graphite/board/ads/reads.ts), for review. Nothing from a page is used until "Use this": that approves
 * the product's facts and the brand's colours on the board's own draft, with Undo, and saves the product as a profile.
 *
 * Products are real packshots only: the page's own photos are imported as originals when you choose them (the
 * import-image route), never generated. Nothing here spends.
 */
export function ProductStage({ ctx }: { ctx: BoardCtx }) {
  const project = ctx.project;
  const pid = project.id;
  const session = useAdsSession(pid);
  const actions = useAdsActions();
  const brief = briefOf(project);
  const [link, setLink] = useState(brief.productUrl);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [imported, setImported] = useState<readonly string[]>([]);

  const read = session.product;
  const brandRead = session.brand?.status === "ready" ? session.brand.result ?? null : null;
  const approved = Boolean(read?.result && brief.productSource?.url === read.result.source.finalUrl);
  const review = useMemo(() => (read?.status === "ready" && read.result && !approved ? productReview(read.result, brandRead) : null), [read, brandRead, approved]);
  const kit = brief.brandKit;
  const made = Boolean(brief.productName.trim()) && !review;
  const images = brief.productAssetIds.map((id) => project.assets.find((a) => a.id === id && a.kind === "image")).filter((a): a is NonNullable<typeof a> => Boolean(a));
  const logo = kit?.logoAssetId ? project.assets.find((a) => a.id === kit.logoAssetId) : undefined;
  const canWrite = !ctx.offline && !ctx.readOnly;

  const readIt = async () => {
    setProblem("");
    const refused = await actions.readSite(link);
    if (refused) setProblem(refused);
  };
  const addPackshot = async (url: string) => {
    setBusy(url); setProblem("");
    try {
      const latest = ctx.rig.project ?? project;
      const asset = await importToDraft(ctx.scope, actions.editor, latest, url, "Product");
      changeBrief(actions.editor, (b) => (b.productAssetIds.includes(asset.id) || b.productAssetIds.length >= OWN_LIMITS.productImages ? b : { ...b, productAssetIds: [...b.productAssetIds, asset.id] }));
      setImported((now) => [...now, url]);
      await actions.editor.ensureSaved();
      refreshLibrary(ctx.scope, latest.id);
    } catch (cause) { setProblem(cause instanceof Error ? cause.message : "The image could not be imported."); }
    setBusy(null);
  };
  const addLogo = async (url: string) => {
    setBusy(url); setProblem("");
    try {
      const latest = ctx.rig.project ?? project;
      const asset = await importToDraft(ctx.scope, actions.editor, latest, url, "Brand");
      changeBrief(actions.editor, (b) => ({ ...b, brandKit: { ...(b.brandKit ?? EMPTY_BRAND_KIT), logoAssetId: asset.id } }));
      setImported((now) => [...now, url]);
      await actions.editor.ensureSaved();
      refreshLibrary(ctx.scope, latest.id);
    } catch (cause) { setProblem(cause instanceof Error ? cause.message : "The logo could not be imported."); }
    setBusy(null);
  };
  const useThis = () => {
    actions.approveProductRead();
    if (brandRead) actions.approveBrandRead();
  };

  return (
    <div className="v12-sp v12-cp v12-cp-product" data-testid="v12-product-stage">
      <section className="v12-sp-card" aria-labelledby="v12-cp-link-h" data-testid="v12-product-link">
        <header className="v12-sp-head"><h2 className="v12-sp-title" id="v12-cp-link-h">{made ? "Product page" : "Paste the product page link"}</h2>
          <span className="v12-sp-state">{read?.status === "reading" ? "Reading…" : "Free"}</span></header>
        <form className="v12-cp-form" onSubmit={(e) => { e.preventDefault(); if (canWrite) void readIt(); }}>
          <input className="v12-cp-input" aria-label="Product page link" placeholder="https://" value={link} onChange={(e) => { setLink(e.target.value); setProblem(""); }} disabled={!canWrite || read?.status === "reading"} data-testid="v12-product-url" />
          <button type="submit" className={made ? "v12-sp-btn" : "v12-sp-btn v12-sp-primary"} disabled={!canWrite || !link.trim() || read?.status === "reading"} aria-busy={read?.status === "reading" || undefined} data-testid="v12-product-read">
            {read?.status === "reading" ? "Reading…" : made ? "Read again" : "Read the page"}
          </button>
        </form>
        {problem ? <p className="v12-sp-why v12-sp-problem" role="alert" data-testid="v12-product-problem">{problem}</p> : null}
        {read?.status === "failed" && !problem ? <p className="v12-sp-why v12-sp-problem" role="alert" data-testid="v12-product-failed">{read.error ?? "The page could not be read."} You can write the details by hand with Edit.</p> : null}
        <dl className="v12-sp-lines">
          <div className="v12-sp-line"><dt>Read</dt><dd>name · what the page says · colours · logo · packshots</dd></div>
          <div className="v12-sp-line"><dt>Rule</dt><dd>Products stay real packshots only. Nothing is generated.</dd></div>
        </dl>
      </section>

      {review ? (
        <section className="v12-sp-card v12-cp-review" aria-labelledby="v12-cp-rev-h" data-testid="v12-product-review">
          <header className="v12-sp-head"><span className="v12-sp-eyebrow">Product · read from the page</span><span className="v12-sp-state" data-testid="v12-product-state">Review before use</span></header>
          <h2 className="v12-sp-title" id="v12-cp-rev-h">{review.name || "No name found"}{review.brand ? ` · ${review.brand}` : ""}</h2>
          <dl className="v12-sp-lines">
            <div className="v12-sp-line"><dt>Says</dt><dd data-testid="v12-product-says">{review.says || "The page gave no description."}</dd></div>
            <div className="v12-sp-line"><dt>Colours</dt><dd>{review.colours.length ? <Swatches colours={review.colours} /> : "None found on the page."}</dd></div>
            <div className="v12-sp-line"><dt>Logo</dt><dd>{review.logos.length ? review.logos.map((l) => (
              <button key={l.url} type="button" className="v12-sp-btn v12-cp-cand" disabled={!canWrite || busy !== null || imported.includes(l.url)} onClick={() => void addLogo(l.url)} title={l.url} data-testid="v12-product-logo-add">{imported.includes(l.url) ? "Logo set" : busy === l.url ? "Importing…" : `Use ${hostOfUrl(l.url) || "this"} logo`}</button>
            )) : "None found on the page."}</dd></div>
            <div className="v12-sp-line"><dt>Packshots</dt><dd data-testid="v12-product-packshots">{review.packshots.length ? <>
              <span>{review.packshots.length} {review.packshots.length === 1 ? "photo" : "photos"} on the page · nothing generated</span>
              <span className="v12-cp-cands">{review.packshots.map((p) => (
                <button key={p.url} type="button" className="v12-sp-btn v12-cp-cand" disabled={!canWrite || busy !== null || imported.includes(p.url) || images.length >= OWN_LIMITS.productImages} onClick={() => void addPackshot(p.url)} title={p.url} data-testid="v12-product-packshot-add">
                  {imported.includes(p.url) ? "Added" : busy === p.url ? "Importing…" : `Add ${p.alt}`}</button>
              ))}</span></> : "None found on the page."}</dd></div>
          </dl>
          {review.warnings.map((w) => <p key={w} className="v12-sp-why">{w}</p>)}
          <div className="v12-sp-acts">
            <button type="button" className="v12-sp-btn v12-sp-primary" disabled={!canWrite || !review.name} onClick={useThis} data-testid="v12-product-use">Use this</button>
            <button type="button" className="v12-sp-btn" onClick={() => actions.edit("product")} data-testid="v12-product-edit">Edit</button>
          </div>
        </section>
      ) : null}

      {made ? (
        <section className="v12-sp-card v12-cp-review" aria-labelledby="v12-cp-made-h" data-testid="v12-product-made">
          <header className="v12-sp-head"><span className="v12-sp-eyebrow">Product</span><span className="v12-sp-state" data-testid="v12-product-state">{brief.activeProductId ? "Approved · saved" : "Approved"}</span></header>
          <h2 className="v12-sp-title" id="v12-cp-made-h">{brief.productName}{brief.productBrand ? ` · ${brief.productBrand}` : ""}</h2>
          <dl className="v12-sp-lines">
            {brief.productDescription?.trim() ? <div className="v12-sp-line"><dt>Facts</dt><dd>{brief.productDescription.trim().slice(0, 240)}</dd></div> : null}
            <div className="v12-sp-line"><dt>Colours</dt><dd>{kit?.colors?.length ? <Swatches colours={kit.colors} /> : "Not read yet."}</dd></div>
            <div className="v12-sp-line"><dt>Logo</dt><dd>{logo ? <>{/* eslint-disable-next-line @next/next/no-img-element -- the project's own original */}<img className="v12-cp-logo" src={logo.url} alt="Logo" data-testid="v12-product-logo" /></> : "Not set."}</dd></div>
            <div className="v12-sp-line"><dt>Packshots</dt><dd data-testid="v12-product-packshots">{images.length ? <span className="v12-cp-thumbs">{images.map((a) => (
              // eslint-disable-next-line @next/next/no-img-element -- the project's own original
              <img key={a.id} className="v12-cp-thumb" src={a.url} alt={a.name} loading="lazy" />))}</span> : "No photos yet. Read the page, or upload one with Edit."}
              {images.length ? ` · ${images.length} real ${images.length === 1 ? "photo" : "photos"} · nothing generated` : ""}</dd></div>
          </dl>
          <div className="v12-sp-acts">
            <button type="button" className="v12-sp-btn" onClick={() => actions.edit("product")} data-testid="v12-product-edit">Edit</button>
            {(brief.products?.length ?? 0) > 1 ? brief.products!.map((p) => (
              <button key={p.id} type="button" className="v12-sp-btn" aria-pressed={p.id === brief.activeProductId} onClick={() => actions.switchProduct(p.id)} data-testid="v12-product-switch">{p.name || "Untitled product"}</button>
            )) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** Colours as swatches with their hex (prototype: 22 px circles, the hex in mono). */
export function Swatches({ colours }: { colours: readonly string[] }) {
  return (
    <span className="v12-cp-swatches" data-testid="v12-swatches">
      {colours.map((c) => <span key={c} className="v12-cp-swatch" data-testid="v12-swatch"><span className="v12-cp-chip" style={{ background: c }} aria-hidden="true" /><span className="v12-cp-hex">{c.toUpperCase()}</span></span>)}
    </span>
  );
}
