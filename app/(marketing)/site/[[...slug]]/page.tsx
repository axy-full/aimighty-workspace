import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import Studio, { metadata as studio } from "../_pages/studio";
import Business, { metadata as business } from "../_pages/business";
import Viral, { metadata as viral } from "../_pages/viral";
import Atomik, { metadata as atomik } from "../_pages/atomik";
import Workspace, { metadata as workspace } from "../_pages/workspace";
import Pricing, { metadata as pricing } from "../_pages/pricing";
import { GuestHome } from "@/components/graphite/guest/GuestHome";
import { guestSample } from "@/lib/guest/sample.server";
import { SAMPLE_TITLE } from "@/lib/guest/sample";
import { approvedWelcomeCredits } from "@/lib/workspaceProvisioning";

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
  studio: { Page: Studio, metadata: studio },
  business: { Page: Business, metadata: business },
  viral: { Page: Viral, metadata: viral },
  atomik: { Page: Atomik, metadata: atomik },
  workspace: { Page: Workspace, metadata: workspace },
  pricing: { Page: Pricing, metadata: pricing },
};

type Props = { params: Promise<{ slug?: string[] }>; searchParams?: Promise<Record<string, string | string[] | undefined>> };
const entryFor = async (params: Props["params"]) => PAGES[((await params).slug ?? []).join("/")] ?? null;

const isRoot = async (params: Props["params"]) => ((await params).slug ?? []).length === 0;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  if (await isRoot(params)) return { title: { absolute: "particl" } };
  return (await entryFor(params))?.metadata ?? {};
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

export default async function SiteRoute({ params, searchParams }: Props) {
  /* "/" for a signed-out visitor is Guest Home (lead decisions 35, 39 and 41: the old homepage was deleted when it
     was turned on). proxy.ts already sends a member, an app link or the old shell to the app instead. */
  if (await isRoot(params)) {
    const q = (await searchParams) ?? {};
    const invite = one(q.invite);
    const [sample, welcome] = await Promise.all([guestSample(), approvedWelcomeCredits().catch(() => null)]);
    return (
      <GuestHome initialView={one(q.sample) === "1" ? "sample" : "home"} initialSignup={one(q.signup) === "1"}
        invite={invite && /^[A-Za-z0-9_-]{8,200}$/.test(invite) ? invite : null}
        sampleTitle={sample?.title ?? SAMPLE_TITLE} sampleBoard={sample?.board ?? null} welcomeCredits={welcome} />
    );
  }
  const entry = await entryFor(params);
  if (!entry) notFound();
  const { Page } = entry;
  return <Page />;
}
