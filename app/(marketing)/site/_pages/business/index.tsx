import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import SitePage from "@/components/marketing/SitePage";
import { Amber, Fact, Grid, Group, Note, Section, SuiteHeader, Window } from "@/components/marketing/ui";
import { ACCESS_HREF, SITE_SUITES, shot } from "@/lib/marketing/site";

export const metadata: Metadata = {
  title: "Business Suite",
  description: "The Moleculr Business Suite: product, brand, cast, format, variants, design and publishing in one marketing studio.",
};

/* Limits as the code enforces them: lib/workbench/studio-schema.ts (moleculrSchema),
   lib/workbench/moleculr.ts (MOLECULR_FORMATS), lib/higgsfieldMarketing.ts (1k–4k). */
const FACTS: [string, string][] = [
  ["Product images", "Up to 5 originals"],
  ["Cast images", "Up to 6, or an identity"],
  ["Formats", "9 creative formats"],
  ["Hooks", "12 per campaign"],
  ["Variants", "Up to 100 bindings"],
];

type Row = { name: string; chip?: string; desc: string; badge?: ReactNode };
const GROUPS: { tag: string; note?: string; rows: Row[] }[] = [
  { tag: "Product", note: "saved references, reviewed before use", rows: [
    { name: "Product details", chip: "saved", desc: "Name, brand, offer and approved claims, saved with the project." },
    { name: "Product images", chip: "5 max", desc: "Up to five originals, kept byte-identical." },
    { name: "Product URL", chip: "reference", desc: "A saved reference. On request one public page is read, and nothing is added until you review it." },
    /* The cut-out still tool (lib/stillTools.ts, Bria Cutout) is built, but no
       screen passes Theatre an onStillTool handler, so nothing in the app opens it. */
    { name: "Cut-out", badge: <Amber>NOT YET RUNNABLE</Amber>, desc: "Pull a clean product cut-out from one of your own photos." },
  ] },
  { tag: "Brand & cast", rows: [
    { name: "Brand", chip: "inherited", desc: "Import a brand kit from your own site URL, then edit voice, palette and type; every variant inherits it." },
    { name: "Presenters", chip: "6 max", desc: "Up to six cast images, or a locked identity from Production." },
    { name: "Custom presenter", chip: "reusable", desc: "Describe a new presenter; the portrait goes through generation review and becomes a reusable cast reference." },
  ] },
  { tag: "Message & format", note: "templates from the connected catalogue", rows: [
    { name: "Hooks", chip: "12", desc: "Twelve opening lines per campaign, written against the brief." },
    { name: "Formats", chip: "9", desc: "Nine formats, from UGC review, tutorial and unboxing to CGI product, poster and motion graphic." },
    { name: "Presets", chip: "live quote", desc: "Ads presets for image variants, read live and quoted on the workspace’s own credits." },
    { name: "Templates", chip: "priced", desc: "The connected account’s template catalogue and cost table, cached for an hour per connection." },
    { name: "Aspect & quality", chip: "4k", desc: "1k, 2k or 4k across the documented ratios." },
  ] },
  { tag: "Variants & output", rows: [
    { name: "Variants", chip: "100 max", desc: "Up to a hundred bindings; each one is a generation node." },
    { name: "Create with template", chip: "quote → approve", desc: "Quoted from the catalogue, approved at the exact connected-credit price, filed with the campaign takes." },
    { name: "Reference ad", chip: "reference", desc: "Start from a video ad you own and adapt its direction to the variant." },
    { name: "Design", chip: "layers", desc: "Editable text, image and shape layers, exported as a full-size PNG original." },
    { name: "Video ads", chip: "engine-backed", desc: "Campaign video through the project’s configured engines." },
    { name: "Review & deliver", chip: "review", desc: "Publish leads to review and delivery. No posting provider is connected." },
  ] },
];

export default function BusinessPage() {
  const suite = SITE_SUITES.find((s) => s.id === "business")!;
  return (
    <SitePage active="business">
      <SuiteHeader
        eyebrow="03 · Moleculr Business Suite"
        title="Build and grow your brand from one marketing studio."
        lead="One studio: a product, who presents it, what it says and where it runs. Configure a variant and it becomes a generation node bound to your saved originals, so a reload or a handoff to Rig keeps every reference."
        pages={suite.pages}
        cta={<>
          <a href={ACCESS_HREF} className="mk-btn gx-primary">Request access</a>
          <Link href="/" className="mk-btn mk-btn--secondary">Open Gen</Link>
        </>}
      />

      <Section id="business-studio" panel label="Marketing Studio">
        <Grid col={180} style={{ gap: 10 }}>
          {FACTS.map(([k, v]) => <Fact key={k} k={k} v={v} />)}
        </Grid>
        <Grid col={400} style={{ gap: 20 }}>
          <Window path="particl.app / business / ads" src={shot("business-ads-marketing-studio")}
            alt="Business, Ads: the Marketing Studio video ad composer" width={924} height={540} />
          <Window path="particl.app / business / image ads" src={shot("business-dtc-image-ads")}
            alt="Business, Image ads: the DTC Ads image composer" width={924} height={540} />
        </Grid>
        <Grid col={270} style={{ alignItems: "start" }}>
          {GROUPS.map((group) => (
            <Group key={group.tag} tag={group.tag} note={group.note} rows={group.rows} />
          ))}
        </Grid>
        <Note lead="Product URLs are saved references,">
          not a claim that a storefront was scraped. Social accounts and posting providers are not connected; Publish leads to review and delivery.
        </Note>
      </Section>
    </SitePage>
  );
}
