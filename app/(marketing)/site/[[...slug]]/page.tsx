import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import Gen, { metadata as gen } from "../_pages/gen";
import Studio, { metadata as studio } from "../_pages/studio";
import Business, { metadata as business } from "../_pages/business";
import Viral, { metadata as viral } from "../_pages/viral";
import Atomik, { metadata as atomik } from "../_pages/atomik";
import Workspace, { metadata as workspace } from "../_pages/workspace";
import Pricing, { metadata as pricing } from "../_pages/pricing";

/**
 * Every page of the public site, served by one route. proxy.ts rewrites the
 * public paths here (/ → /site, /studio → /site/studio, …) and the path picks
 * the page. One route rather than seven because a dev server compiles each
 * route it has not seen with a spike of several GB, and seven of them back to
 * back ran CI's browser runners out of memory (docs: the [resources] lines in
 * the Browser suite step).
 */
type Entry = { Page: () => ReactNode | Promise<ReactNode>; metadata: Metadata };
const PAGES: Record<string, Entry> = {
  "": { Page: Gen, metadata: gen },
  studio: { Page: Studio, metadata: studio },
  business: { Page: Business, metadata: business },
  viral: { Page: Viral, metadata: viral },
  atomik: { Page: Atomik, metadata: atomik },
  workspace: { Page: Workspace, metadata: workspace },
  pricing: { Page: Pricing, metadata: pricing },
};

type Props = { params: Promise<{ slug?: string[] }> };
const entryFor = async (params: Props["params"]) => PAGES[((await params).slug ?? []).join("/")] ?? null;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return (await entryFor(params))?.metadata ?? {};
}

export default async function SiteRoute({ params }: Props) {
  const entry = await entryFor(params);
  if (!entry) notFound();
  const { Page } = entry;
  return <Page />;
}
