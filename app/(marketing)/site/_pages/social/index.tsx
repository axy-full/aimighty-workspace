import type { Metadata } from "next";
import Link from "next/link";
import SitePage from "@/components/marketing/SitePage";
import { Cols, Fact, Grid, Section, SuiteHeader, Tile, Window } from "@/components/marketing/ui";
import { ACCESS_HREF, SITE_SUITES, shot } from "@/lib/marketing/site";

export const metadata: Metadata = {
  title: "Social",
  description: "Recast motion and swap elements in footage you own: one 4–8 s source, ordered references, 480p to 1080p.",
};

/* Limits from lib/shell/viral.ts (SOURCE_SECONDS, from GENJUTSU_LIMITS) and
   lib/genjutsuTypes.ts (resolutions). What each tile says is what the Social
   board holds today (components/graphite/board/social): the source card, the
   two quick tools and the History drawer. The public site states no prices. */
const DIRECTIONS = ["Style", "Wardrobe", "Setting", "Product", "Recast"];

const TILES: { tag: string; name: string; body: string }[] = [
  { tag: "01 Source", name: "Your own footage",
    body: "Upload a video or use one made in Particl. The original is kept, and you can pull its start or end frame as a PNG." },
  { tag: "02 Motion transfer", name: "Recast the motion",
    body: `Take the motion from a source video and recast it with your own cast, location and product. Anything you do not describe stays as filmed. Five directions to start from: ${DIRECTIONS.join(", ")}.` },
  { tag: "03 Object swap", name: "Swap one element",
    body: "A product, a garment, an object. Name what to replace; motion, lighting and framing stay as filmed." },
  { tag: "04 History", name: "Every result, kept",
    body: "Recreate a take with the same inputs, compare it with the original, send it to the edit or download it." },
];

const FACTS: [string, string][] = [
  ["Source", "4–8 s"],
  ["References", "Ordered stills"],
  ["Resolution", "480p · 720p · 1080p"],
];

const social = SITE_SUITES.find((suite) => suite.id === "social")!;

export default function SocialPage() {
  return (
    <SitePage active="social">
      <SuiteHeader
        eyebrow="03 · Social"
        title="Recast motion and swap elements in footage you own."
        lead="Take the motion from a source video and recast it with your own cast, location and product, or swap one element and leave the rest as filmed."
        pages={social.pages}
        cta={(
          <>
            <a href={ACCESS_HREF} className="mk-btn gx-primary">Request access</a>
            <Link href="/" className="mk-btn mk-btn--secondary">Open Make</Link>
          </>
        )}
      />

      {/* The header already draws the hairline above this section. */}
      <Section id="social-board" panel label="Social" style={{ borderTop: 0 }}>
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
