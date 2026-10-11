import type { Metadata } from "next";
import Link from "next/link";
import SitePage from "@/components/marketing/SitePage";
import { Fact, Grid, Group, Section, SuiteHeader } from "@/components/marketing/ui";
import { ACCESS_HREF, SITE_SUITES } from "@/lib/marketing/site";

export const metadata: Metadata = {
  title: "Ads",
  description: "Ads: set the product and brand once, write hooks, pick a format and make image ads that keep every reference.",
};

/* Limits as the code enforces them: lib/shell/business-own.ts (OWN_LIMITS: 5 product images, 12 hooks)
   and lib/workbench/moleculr.ts (MOLECULR_FORMATS: nine). What each row says is what the Ads board
   holds today (components/graphite/board/ads): the brand, product, reference, hooks, formats and ads cards. */
const FACTS: [string, string][] = [
  ["Product images", "Up to 5 originals"],
  ["Hooks", "12 per brief"],
  ["Formats", "9 creative formats"],
];

type Row = { name: string; chip?: string; desc: string };
const GROUPS: { tag: string; note?: string; rows: Row[] }[] = [
  { tag: "Brand", rows: [
    { name: "Brand kit", chip: "inherited", desc: "Name, voice, colours and type, saved with the project. Every ad starts from it." },
  ] },
  { tag: "Product", note: "reviewed before use", rows: [
    { name: "Product facts", chip: "approved", desc: "Name, brand and facts, written by hand or read from a page you point to. Nothing is kept until you approve it." },
    { name: "Product images", chip: "5 max", desc: "Up to five originals." },
    { name: "Reference ad", chip: "optional", desc: "A video you own, to learn the pacing and framing from. Its price is shown before it runs." },
  ] },
  { tag: "Hooks & formats", rows: [
    { name: "Hooks", chip: "12", desc: "Up to twelve opening lines, written against the brief." },
    { name: "Formats", chip: "9", desc: "From UGC review, tutorial and unboxing to CGI product, poster and motion graphic." },
  ] },
  { tag: "Ads", rows: [
    { name: "Image ads", desc: "Made on the board or in Make, each with its price on the button." },
    { name: "Results", desc: "Approve or reject each one, use it as a reference, or open an image in the Designer." },
  ] },
];

const ads = SITE_SUITES.find((s) => s.id === "ads")!;

export default function AdsPage() {
  return (
    <SitePage active="ads">
      <SuiteHeader
        eyebrow="02 · Ads"
        title="Set the product once. Make the ads."
        lead="A product, a brand and a hook in, image ads out. Every ad starts from the same brief and keeps the same references."
        pages={ads.pages}
        cta={<>
          <a href={ACCESS_HREF} className="mk-btn gx-primary">Request access</a>
          <Link href="/" className="mk-btn mk-btn--secondary">Open Make</Link>
        </>}
      />

      <Section id="ads-board" panel label="The Ads board" style={{ borderTop: 0 }}>
        <Grid col={180} style={{ gap: 10 }}>
          {FACTS.map(([k, v]) => <Fact key={k} k={k} v={v} />)}
        </Grid>
        <Grid col={270} style={{ alignItems: "start" }}>
          {GROUPS.map((group) => (
            <Group key={group.tag} tag={group.tag} note={group.note} rows={group.rows} />
          ))}
        </Grid>
      </Section>
    </SitePage>
  );
}
