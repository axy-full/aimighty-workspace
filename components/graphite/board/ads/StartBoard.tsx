"use client";
import { useState } from "react";
import { Price } from "@/components/graphite/Price";
import { FREE } from "@/lib/shell/price-words";
import type { BoardCtx } from "../cards/types";
import { useAdsSession } from "./ads-session";
import { useAdsActions } from "./use-ads-actions";
import { openPanel } from "./ads-session";

/*
 * The empty Ads board (gap G1; decision 32: follow the empty Studio board until Claude Design draws it): a centred box for the
 * product page, one primary, "Read the site · free". It reads the product page and the brand's home page, both free; the
 * Brand kit and Product facts cards then wait for the person's review.
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
      <form className="ab-start-box" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <h2>What is the ad for?</h2>
        <p>Paste the product page. Particl reads the page and the brand&apos;s site, then asks you to review what it found.</p>
        <input className="ab-input" type="url" inputMode="url" aria-label="Product page" placeholder="https://your-product.com/page" value={url} maxLength={2000} onChange={(e) => setUrl(e.target.value)} disabled={reading} data-testid="ads-start-url" />
        <span className="ab-start-actions">
          <button type="submit" className="ab-btn ab-btn--solid" disabled={reading || !url.trim()} data-testid="ads-start-read">{reading ? "Reading the site…" : <>Read the site · <Price value={FREE} /></>}</button>
          <button type="button" className="ab-btn" onClick={() => openPanel(ctx.project.id, "product")} data-testid="ads-start-hand">Write the details by hand</button>
        </span>
        {problem ? <p className="ab-note" data-tone="bad" role="alert">{problem}</p> : null}
        {failed ? <p className="ab-note" data-tone="bad" role="alert">{failed} <button type="button" className="ab-link" onClick={() => void go()}>Try again</button></p> : null}
      </form>
    </div>
  );
}
