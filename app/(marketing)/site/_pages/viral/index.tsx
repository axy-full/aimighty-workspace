import type { Metadata } from "next";
import Link from "next/link";
import SitePage from "@/components/marketing/SitePage";
import { Cols, Fact, Grid, Note, Section, SuiteHeader, Tile, Window } from "@/components/marketing/ui";
import { ACCESS_HREF, SITE_SUITES, shot } from "@/lib/marketing/site";

export const metadata: Metadata = {
  title: "Viral Studio",
  description: "Recast motion and swap elements in footage you own: one 4–30 s source, up to 30 ordered references, 480p to 1080p, quoted live.",
};

/* Copy and limits from lib/workspace/spec-cards.ts, lib/shell/viral.ts,
   lib/higgsfield-consumer/{genjutsu-contract,shorts-studio}.ts and
   components/suites/subatomik-directions.ts. Every run here is quoted live by
   the connected account, so no credit figure is printed. */
const DIRECTIONS = ["Style", "Wardrobe", "Setting", "Product", "Recast"];

const TILES: { tag: string; name: string; body: string; price?: string; note?: string }[] = [
  { tag: "01 Motion Transfer", name: "Recast the motion",
    body: `Take the motion from a source video and recast it with your own cast, location and product. Anything you do not describe stays exactly as filmed. Five creative directions to start from: ${DIRECTIONS.join(", ")}.`,
    price: "Live quote", note: "480p · 720p · 1080p" },
  { tag: "02 Object Swap", name: "Swap one element",
    body: "A product, a garment, an object. Name what to replace; motion, lighting and framing stay as filmed.",
    price: "Live quote", note: "480p · 720p · 1080p" },
  { tag: "03 Shorts", name: "One video, a set of clips",
    body: "Restyle one video (4–120 s) into a set of short clips; one quote covers the whole set.",
    price: "Live quote", note: "per set" },
  { tag: "04 Sources", name: "Your own originals",
    body: "Nothing is fetched from a URL at generation time and nothing is re-encoded on the way in. Header bytes are read; pixels are never touched. Pull the start or end frame as a PNG." },
  { tag: "05 Compare", name: "Split or wipe, one clock",
    body: "Original and result side by side, locked to the same clock. Seek and speed apply to both sides; download the original bytes." },
  { tag: "06 History", name: "Every result, kept",
    body: "Copied into private storage on completion. Recreate any take with the same inputs, or hand it to Edit & Sound or to upscale. Connected-credit receipts are recorded separately." },
];

const FACTS: [string, string][] = [
  ["Source", "4–30 s"],
  ["References", "Up to 30, ordered"],
  ["Resolution", "480p · 720p · 1080p"],
  ["Billing", "Connected credits"],
];

const viral = SITE_SUITES.find((suite) => suite.id === "viral")!;

export default function ViralPage() {
  return (
    <SitePage active="viral">
      <SuiteHeader
        eyebrow="04 · Subatomik Viral Studio"
        title="Recast motion and swap elements in footage you own."
        lead="Take the motion from a source video and recast it with your own cast, location and product, or swap one element and leave the rest exactly as filmed. One source of 4 to 30 seconds, up to 30 ordered references, 480p to 1080p, quoted live before anything is sent."
        pages={viral.pages}
        cta={(
          <>
            <a href={ACCESS_HREF} className="mk-btn gx-primary">Request access</a>
            <Link href="/" className="mk-btn mk-btn--secondary">Open Gen</Link>
          </>
        )}
      />

      {/* The suite header already draws the hairline above this section. */}
      <Section id="viral-studio" panel label="Viral Studio" style={{ borderTop: 0 }}>
        <Cols col={420} style={{ gap: "clamp(32px, 5vw, 72px)" }}>
          <Grid col={200}>
            {TILES.map(({ tag, name, body, price, note }) => (
              <Tile key={tag} tag={tag} name={name} body={body} price={price} priceNote={note} />
            ))}
          </Grid>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <Window path="particl.app / viral / motion" src={shot("viral-motion-transfer")} alt="Viral, Motion Transfer" width={924} height={540} />
            <Window path="particl.app / viral / history" src={shot("viral-history")} alt="Viral, History" width={924} height={540} />
            {/* Two pairs, so the four facts sit 4 across or 2 × 2, never 3 + 1. */}
            <Grid col={290} style={{ gap: 10 }}>
              {[FACTS.slice(0, 2), FACTS.slice(2)].map((pair) => (
                <Grid key={pair[0][0]} col={140} style={{ gap: 10 }}>
                  {pair.map(([k, v]) => <Fact key={k} k={k} v={v} />)}
                </Grid>
              ))}
            </Grid>
            <Note lead="Live quote required.">A missing or stale estimate blocks submission; the exact price and wallet are approved before anything is sent.</Note>
          </div>
        </Cols>
      </Section>
    </SitePage>
  );
}
