import SitePage, { sitePrices } from "@/components/marketing/SitePage";
import HeroPrompt from "@/components/marketing/HeroPrompt";
import { Cols, Grid, Head, Section, Stat, Tile, Window } from "@/components/marketing/ui";
import { GPT_IMAGE, KLING_PRO, NANO_2, NANO_PRO, SEEDANCE_20, SEEDANCE_25, TOPAZ } from "@/lib/marketing/prices.server";
import { shot } from "@/lib/marketing/site";

export const metadata = { title: { absolute: "particl studio · the studio's own room for making shots" } };

const COMPOSER_TILES: [string, string, string][] = [
  ["01 Direction", "One prompt, cited", "@Image1 and @name point at references. A raw: prefix sends your exact words past the enhancer."],
  ["02 Model", "Model sheet", "Studio engines, with tag, best-for and roles on every row."],
  ["03 References", "Drop well", "Roles cycle per model: Start frame, End frame, Reference, Video, Audio. Drag anything in from the Library."],
  ["04 Settings", "Clamped to the engine", "Aspect, resolution, length by the second, audio on or off, one to four takes."],
  ["05 Results", "Progress rings", "Running jobs as rings, then finished takes, filtered All · Images · Video · Audio."],
  ["Edit", "Edit a finished clip", "A take or an upload, up to 8 image references and an edit direction."],
  ["Finish", "Upscale in place", "Topaz Astra 2 for video and Topaz for stills. The original is kept; the upscale is a new take with its lineage."],
  ["Recover", "Nothing lost on reload", "Drafts, interrupted requests and lost responses come back as “Recover …”. Reusing a take loads its prompt; it never starts a job by itself."],
  ["Modes", "Video · Images · Audio", "One segment switches the composer. Every tool in every suite is a preset that opens it pre-configured."],
];

export default async function GenHome() {
  const { hero, engines } = await sitePrices();
  const engine = (id: string) => engines[id];
  const ENGINES = [
    { id: SEEDANCE_25, kind: "Video", role: "Video engine", body: "Standard video. Highest fidelity, native audio, up to 30 s and 30 reference images." },
    { id: SEEDANCE_20, kind: "Video", role: "Video engine", body: "Drafts and roughs. 4 to 15 s." },
    { id: KLING_PRO, kind: "Video", role: "Video engine", body: "Water, cloth and physics-heavy motion, steadier for finals. Native audio, 3 to 15 s." },
    { id: NANO_PRO, kind: "Image", role: "Still engine", body: "Stills with legible text, up to 4K, up to 14 references." },
    { id: NANO_2, kind: "Image", role: "Still engine", body: "Quick stills. Board frames start here." },
    { id: GPT_IMAGE, kind: "Image", role: "Still engine", body: "Exact text and faithful edits. Sunburst and Flare builds, up to 10 references." },
    { id: TOPAZ, kind: "Post", role: "Finishing", body: "Creative video upscale to 4K, with frame rate and detail controls." },
  ];

  return (
    <SitePage active="gen">
      <section className="mk-hero" aria-label="Make">
        {/* eslint-disable-next-line @next/next/no-img-element -- the campaign still, full bleed */}
        <img className="mk-hero-img" src="/campaign/hero.webp" alt="" width={1672} height={941} fetchPriority="high" />
        <div className="mk-hero-shade" aria-hidden="true" />
        <div className="mk-hero-in">
          <div className="mk-eyebrow">Make · Video · Images · Audio</div>
          <h1 className="mk-h1 mk-hero-title">The studio&rsquo;s own room for making shots.</h1>
          <p className="mk-hero-lead">One board for the whole production: Studio, Ads, Social, Make and the Atomik agent. Seedance, Kling and Nano Banana behind them.</p>
          <HeroPrompt model={hero.id} label={hero.name} short={hero.short} />
        </div>
      </section>

      <Section id="gen-composer" label="Make composer">
        <Head eyebrow="Make · one composer" title="One composer for video, images and audio."
          lead="Every tool in every suite is a preset that opens it pre-configured; there is never a second interface." />
        <Cols col={420}>
          <Window path="particl.si / make" src={shot("make-panel")} alt="Make over the board, with the engine line and its price" width={924} height={540} />
          <Grid col={220}>
            <Stat figure="4–30 s" name="Length by the second" body="Any whole second a video engine accepts. Ratio, resolution and audio clamp when you switch engines." />
            <Stat figure="SHA-256" name="References stay byte-identical" body="No resize, no re-encode, no metadata stripping. The rail shows ✓ BYTE-IDENTICAL when the hash matches." />
          </Grid>
        </Cols>
        <Grid col={200}>
          {COMPOSER_TILES.map(([tag, name, body]) => <Tile key={tag} tag={tag} name={name} body={body} />)}
        </Grid>
      </Section>

      <Section id="gen-engines" label="Engines">
        <Head eyebrow="Engines" title="Pick the engine per shot."
          lead="Studio engines in the model sheet. Settings clamp to what the engine accepts." />
        <Grid col={250}>
          {ENGINES.map(({ id, kind, role, body }) => {
            const e = engine(id);
            return (
              <Tile key={id} tag={<span className="mk-chip mk-chip--tint">{e.short}</span>} badge={<span className="mk-tag">{kind}</span>}
                name={e.name} sub={role} body={body} />
            );
          })}
          <Tile tag={<span className="mk-chip mk-chip--tint">11 V3</span>} badge={<span className="mk-tag">Audio</span>}
            name="Eleven v3" sub="Audio engine" body="Dialogue lines, sound effects and music sketches, straight into the Edit lanes." />
        </Grid>
      </Section>
    </SitePage>
  );
}
