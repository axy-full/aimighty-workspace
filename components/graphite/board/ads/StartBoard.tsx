"use client";
import { useState } from "react";
import { Price } from "@/components/graphite/Price";
import { FREE } from "@/lib/shell/price-words";
import type { BoardCtx } from "../cards/types";
import { useAdsSession } from "./ads-session";
import { useAdsActions } from "./use-ads-actions";
import { openPanel } from "./ads-session";
import { CREATIVE_TEMPLATES } from "@/lib/workbench/moleculr-creative";

/** The ad briefs the row offers: a launch, a single hero statement, and a presenter talking to camera (the code's own, by name). */
const START_TEMPLATES = ["launch-poster", "hero-ad", "ugc-presenter"].flatMap((id) => CREATIVE_TEMPLATES.filter((t) => t.id === id));

/*
 * The empty Ads board on first open (Gaps B frames, "Ads and Social"): one question, "What are we advertising?", one action,
 * "Read the site · free" (a product page or a brand site), and a row of templates. It reads the product page and the brand's home
 * page, both free; the Brand kit and Product facts cards then wait for the person's review. A template is the ad brief the code
 * already has (CREATIVE_TEMPLATES): choosing one sets the brief's format, aspect and length, a free draft edit, and nothing
 * is made until a person presses a priced button in Make. The frame's "Start · up to N cr" (Atomik's thinking) stays in the docked
 * panel, where Atomik's own Ask carries its price.
 */
export function StartBoard({ ctx }: { ctx: BoardCtx }) {
  return <Start ctx={ctx} />;
}

function Start({ ctx }: { ctx: BoardCtx }) {
  const act = useAdsActions();
  const session = useAdsSession(ctx.project.id);
  const [url, setUrl] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const reading = session.product?.status === "reading" || session.brand?.status === "reading";
  const failed = session.product?.status === "failed" && session.brand?.status === "failed" ? session.product.error ?? null : null;
  const go = async () => { setProblem(await act.readSite(url)); };
  return (
    <div className="ab-start" data-testid="ads-start">
      <form className="ab-start-box" noValidate onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <h2>What are we advertising?</h2>
        <input className="ab-input" type="url" inputMode="url" aria-label="A product page or a brand site" placeholder="Paste a product page or a brand site" value={url} maxLength={2000} onChange={(e) => setUrl(e.target.value)} disabled={reading} data-testid="ads-start-url" />
        <span className="ab-start-actions">
          <button type="submit" className="ab-btn ab-btn--solid" disabled={reading || !url.trim()} data-testid="ads-start-read">{reading ? "Reading the site…" : <>Read the site · <Price value={FREE} /></>}</button>
          <button type="button" className="ab-btn" onClick={() => openPanel(ctx.project.id, "product")} data-testid="ads-start-hand">Write it by hand</button>
        </span>
        <p className="ab-start-line">Particl reads the page and the brand&apos;s site, then asks you to review what it found.</p>
        <div className="ab-start-templates" role="group" aria-label="Templates" data-testid="ads-start-templates">
          {START_TEMPLATES.map((t) => <button key={t.id} type="button" className="ab-btn" onClick={() => act.chooseBrief(t.id)} data-testid="ads-start-template">{t.name}</button>)}
        </div>
        {problem ? <p className="ab-note" data-tone="bad" role="alert">{problem}</p> : null}
        {failed ? <p className="ab-note" data-tone="bad" role="alert">{failed} <button type="button" className="ab-link" onClick={() => void go()}>Try again</button></p> : null}
      </form>
    </div>
  );
}
