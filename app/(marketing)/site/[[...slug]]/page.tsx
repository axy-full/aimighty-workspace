import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import Gen, { metadata as gen } from "../_pages/gen";
import Studio, { metadata as studio } from "../_pages/studio";
import Ads, { metadata as ads } from "../_pages/ads";
import Social, { metadata as social } from "../_pages/social";
import Atomik, { metadata as atomik } from "../_pages/atomik";
import Settings, { metadata as settings } from "../_pages/settings";
import Pricing, { metadata as pricing } from "../_pages/pricing";
import { GuestHome } from "@/components/graphite/guest/GuestHome";
import { readSite } from "@/lib/site/settings.server";
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
  "": { Page: Gen, metadata: gen },
  studio: { Page: Studio, metadata: studio },
  ads: { Page: Ads, metadata: ads },
  social: { Page: Social, metadata: social },
  atomik: { Page: Atomik, metadata: atomik },
  settings: { Page: Settings, metadata: settings },
  pricing: { Page: Pricing, metadata: pricing },
};

type Props = { params: Promise<{ slug?: string[] }>; searchParams?: Promise<Record<string, string | string[] | undefined>> };
const entryFor = async (params: Props["params"]) => PAGES[((await params).slug ?? []).join("/")] ?? null;

const isRoot = async (params: Props["params"]) => ((await params).slug ?? []).length === 0;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  if ((await isRoot(params)) && (await readSite()).guestHome) return { title: { absolute: "particl" } };
  return (await entryFor(params))?.metadata ?? {};
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

export default async function SiteRoute({ params, searchParams }: Props) {
  /* "/" for a signed-out visitor: Guest Home when the platform owner turned it on in /admin (lead decision 35),
     else today's page. proxy.ts already sends a member, an app link or the old shell to the app instead. */
  if ((await isRoot(params)) && (await readSite()).guestHome) {
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
