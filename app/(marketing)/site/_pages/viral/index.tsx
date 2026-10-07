import type { Metadata } from "next";
import Link from "next/link";
import SitePage from "@/components/marketing/SitePage";
import { Cols, Fact, Grid, Section, SuiteHeader, Tile, Window } from "@/components/marketing/ui";
import { ACCESS_HREF, SITE_SUITES, shot } from "@/lib/marketing/site";

export const metadata: Metadata = {
  title: "Social",
  description: "Recast motion and swap elements in footage you own: one 4–8 s source, ordered references, 480p to 1080p.",
};

/* Copy and limits from lib/workspace/spec-cards.ts, lib/shell/viral.ts,
   lib/genjutsuTypes.ts and components/suites/subatomik-directions.ts. No
   reference count is stated while Viral moves to the API's one to eight
   (docs/subatomik-genjutsu.md). The public site states no prices. */
const DIRECTIONS = ["Style", "Wardrobe", "Setting", "Product", "Recast"];

const TILES: { tag: string; name: string; body: string }[] = [
  { tag: "01 Motion Transfer", name: "Recast the motion",
    body: `Take the motion from a source video and recast it with your own cast, location and product. Anything you do not describe stays exactly as filmed. Five creative directions to start from: ${DIRECTIONS.join(", ")}.` },
  { tag: "02 Object Swap", name: "Swap one element",
    body: "A product, a garment, an object. Name what to replace; motion, lighting and framing stay as filmed." },
  { tag: "03 Sources", name: "Your own originals",
    body: "Nothing is fetched from a URL at generation time and nothing is re-encoded on the way in. Header bytes are read; pixels are never touched. Pull the start or end frame as a PNG." },
  { tag: "04 Compare", name: "Split or wipe, one clock",
    body: "Original and result side by side, locked to the same clock. Seek and speed apply to both sides; download the original bytes." },
  { tag: "05 History", name: "Every result, kept",
    body: "Copied into private storage on completion. Recreate any take with the same inputs, or hand it to Edit & Sound or to upscale." },
];

const FACTS: [string, string][] = [
  ["Source", "4–8 s"],
  ["References", "Ordered stills"],
  ["Resolution", "480p · 720p · 1080p"],
];

const viral = SITE_SUITES.find((suite) => suite.id === "viral")!;

export default function ViralPage() {
  return (
    <SitePage active="viral">
      <SuiteHeader
        eyebrow="04 · Social"
        title="Recast motion and swap elements in footage you own."
        lead="Take the motion from a source video and recast it with your own cast, location and product, or swap one element and leave the rest exactly as filmed. One source of 4 to 8 seconds, ordered references, 480p to 1080p."
        pages={viral.pages}
        cta={(
          <>
            <a href={ACCESS_HREF} className="mk-btn gx-primary">Request access</a>
            <Link href="/" className="mk-btn mk-btn--secondary">Open Make</Link>
          </>
        )}
      />

      {/* The suite header already draws the hairline above this section. */}
      <Section id="viral-studio" panel label="Social" style={{ borderTop: 0 }}>
        <Cols col={420} style={{ gap: "clamp(32px, 5vw, 72px)" }}>
          <Grid col={200}>
            {TILES.map(({ tag, name, body }) => (
              <Tile key={tag} tag={tag} name={name} body={body} />
            ))}
          </Grid>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <Window path="particl.si / make / motion transfer" src={shot("make-motion-transfer")} alt="Motion transfer in Make: one source video and references" width={924} height={540} />
            <Grid col={140} style={{ gap: 10 }}>
              {FACTS.map(([k, v]) => <Fact key={k} k={k} v={v} />)}
            </Grid>
          </div>
        </Cols>
      </Section>
    </SitePage>
  );
}
