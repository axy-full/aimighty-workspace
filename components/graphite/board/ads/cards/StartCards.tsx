"use client";
import type { CardProps } from "../../cards/types";
import type { BrandData, ProductData, ReferenceData } from "../ads-model";
import { useAdsActions } from "../use-ads-actions";
import { Actions, Btn, Meta, Note, Rows, Title, Well } from "./common";

/* Frame 1 of the Ads board: Brand kit, Product facts and Reference ad (the group "Brand, product and reference"). */

export function BrandCard({ data }: CardProps<BrandData>) {
  const act = useAdsActions();
  const review = data.phase === "review";
  if (data.phase === "none") return (
    <article className="bd-card ab-card" data-testid="ads-brand">
      <span className="ab-body">
        <span className="ab-eyebrow">Brand kit</span>
        <Title>No brand kit yet</Title>
        <Meta>Read it from the brand&apos;s site, or write it by hand.</Meta>
        <Actions><Btn primary onClick={() => act.edit("brand")}>Write it by hand</Btn></Actions>
      </span>
    </article>
  );
  if (data.phase === "reading") return (
    <article className="bd-card ab-card" data-testid="ads-brand" aria-busy="true">
      <span className="ab-body"><span className="ab-eyebrow">Brand kit</span><Title>Reading {data.host || "the site"}…</Title><Meta>One public page, free. Nothing is used until you approve it.</Meta></span>
    </article>
  );
  if (data.phase === "failed") return (
    <article className="bd-card ab-card" data-testid="ads-brand">
      <span className="ab-body">
        <span className="ab-eyebrow">Brand kit</span>
        <Title>The site could not be read</Title>
        <Note tone="bad" role="alert">{data.error}</Note>
        <Actions>
          <Btn primary onClick={() => act.tryAgain(data.website)}>Try again</Btn>
          <Btn onClick={() => act.edit("brand")}>Write it by hand</Btn>
        </Actions>
      </span>
    </article>
  );
  return (
    <article className="bd-card ab-card" data-testid="ads-brand" data-phase={data.phase}>
      <span className="ab-body ab-body--kit">
        <span className="ab-swatches" aria-label="Colours">
          {data.colors.slice(0, 4).map((c, i) => <i key={`${c}:${i}`} style={{ background: c }} title={c.toUpperCase()} />)}
        </span>
        {data.logoUrl
          /* eslint-disable-next-line @next/next/no-img-element */
          ? <img className="ab-logo" src={data.logoUrl} alt={data.name} draggable={false} />
          : <span className="ab-wordmark">{data.name || "Brand"}</span>}
        <span className="ab-meta">Aa Bb Cc 0123{data.typefaces ? ` · ${data.typefaces}` : ""}</span>
        <Title>{data.name || "Brand"} · brand kit</Title>
        <Meta>{data.host ? `Read from ${data.host}` : "Written by hand"}</Meta>
        <Rows rows={[
          { label: "Colours", value: data.colors.slice(0, 4).map((c) => c.toUpperCase()).join(" · ") || "None yet", mono: true },
          { label: "Type", value: data.typefaces || "System" },
          { label: "Tone", value: data.tone || "Not written yet" },
        ]} />
        <Actions>
          {review ? <Btn primary onClick={act.approveBrandRead} data-testid="ads-brand-approve">Approve</Btn> : null}
          <Btn onClick={() => act.edit("brand")} data-testid="ads-brand-edit">Edit</Btn>
        </Actions>
      </span>
    </article>
  );
}

export function ProductCard({ data }: CardProps<ProductData>) {
  const act = useAdsActions();
  if (data.phase === "none") return (
    <article className="bd-card ab-card" data-testid="ads-product">
      <span className="ab-body">
        <span className="ab-eyebrow">Product facts</span>
        <Title>No product yet</Title>
        <Meta>Read the product page, or write the facts by hand.</Meta>
        <Actions><Btn primary onClick={() => act.edit("product")}>Write it by hand</Btn></Actions>
      </span>
    </article>
  );
  if (data.phase === "reading") return (
    <article className="bd-card ab-card" data-testid="ads-product" aria-busy="true">
      <span className="ab-body"><span className="ab-eyebrow">Product facts</span><Title>Reading {data.host || "the page"}…</Title><Meta>One public page, free. Nothing is used until you approve it.</Meta></span>
    </article>
  );
  if (data.phase === "failed") return (
    <article className="bd-card ab-card" data-testid="ads-product">
      <span className="ab-body">
        <span className="ab-eyebrow">Product facts</span>
        <Title>The page could not be read</Title>
        <Note tone="bad" role="alert">{data.error}</Note>
        <Actions><Btn primary onClick={() => act.tryAgain(data.url)}>Try again</Btn><Btn onClick={() => act.edit("product")}>Write it by hand</Btn></Actions>
      </span>
    </article>
  );
  const review = data.phase === "review";
  return (
    <article className="bd-card ab-card" data-testid="ads-product" data-phase={data.phase}>
      <Well url={data.imageUrl} media="image" tag="PRODUCT FACTS" height={150} empty={review ? "Images are added with Edit" : "No image yet"} />
      <span className="ab-body">
        <Title>{data.name}</Title>
        <Meta>{data.host ? `From ${data.host}` : "Written by hand"}</Meta>
        <Rows rows={[
          { label: "Brand", value: data.brand || "Not set" },
          { label: "Facts", value: data.facts || "None yet" },
          { label: "Images", value: `${data.images} of 5`, mono: true },
        ]} />
        <Actions>
          {review ? <Btn primary onClick={act.approveProductRead} data-testid="ads-product-approve">Approve</Btn> : null}
          <Btn onClick={() => act.edit("product")} data-testid="ads-product-edit">Edit</Btn>
        </Actions>
      </span>
    </article>
  );
}

export function ReferenceCard({ data }: CardProps<ReferenceData>) {
  const act = useAdsActions();
  if (data.phase === "none") return (
    <article className="bd-card ab-card" data-testid="ads-reference">
      <span className="ab-body">
        <span className="ab-eyebrow">Reference ad</span>
        <Title>No reference ad yet</Title>
        <Meta>A video you own, to learn the pacing and framing from.</Meta>
        <Actions><Btn primary onClick={() => act.edit("reference")} data-testid="ads-reference-choose">Choose a video</Btn></Actions>
      </span>
    </article>
  );
  return (
    <article className="bd-card ab-card" data-testid="ads-reference" data-phase={data.phase}>
      <Well url={data.videoUrl} media="video" tag="REFERENCE AD" height={150} />
      <span className="ab-body">
        <Title>Reference · {data.name}</Title>
        <Meta>{data.phase === "running" ? "Reviewing it now" : "A video you own · what to adapt"}</Meta>
        <Rows rows={data.rows} />
        <Actions>
          {data.phase === "review" ? <Btn primary onClick={act.approveReference} data-testid="ads-reference-approve">Approve</Btn> : null}
          {data.phase === "chosen" || data.phase === "done" ? <Btn primary={data.phase === "chosen"} onClick={() => act.openDialog("reference")} data-testid="ads-reference-review">Review it</Btn> : null}
          <Btn onClick={() => act.edit("reference")} data-testid="ads-reference-replace">{data.phase === "running" ? "Open" : "Replace"}</Btn>
        </Actions>
        {data.phase === "chosen" || data.phase === "done" ? <Meta>Priced before it runs · you approve the price</Meta> : null}
      </span>
    </article>
  );
}
