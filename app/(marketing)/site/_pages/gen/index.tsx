import SitePage, { sitePrices } from "@/components/marketing/SitePage";
import HeroPrompt from "@/components/marketing/HeroPrompt";
import { Cols, Grid, Head, Section, Stat, Tile, Window } from "@/components/marketing/ui";
import { cr } from "@/lib/marketing/format";
import { GPT_IMAGE, KLING_PRO, NANO_2, NANO_PRO, SEEDANCE_20, SEEDANCE_25, TOPAZ } from "@/lib/marketing/prices.server";
import { shot } from "@/lib/marketing/site";

export const metadata = { title: { absolute: "particl studio · the studio's own room for making shots" } };

const COMPOSER_TILES: [string, string, string][] = [
  ["01 Direction", "One prompt, cited", "@Image1 and @name point at references. A raw: prefix sends your exact words past the enhancer."],
  ["02 Model", "Model sheet", "Studio engines and the connected catalogue: tag, best-for, roles and price on every row."],
  ["03 References", "Drop well", "Roles cycle per model: Start frame, End frame, Reference, Video, Audio. Drag anything in from the Library."],
  ["04 Settings", "Clamped to the engine", "Aspect, resolution, length by the second, audio on or off, one to four takes."],
  ["05 Results", "Progress rings", "Running jobs as rings, then finished takes, filtered All · Images · Video · Audio."],
  ["Edit", "Edit a finished clip", "A take or an upload, up to 8 image references and an edit direction. Quoted from the source's real duration; a changed quote is refused before any new charge."],
  ["Finish", "Upscale in place", "Astra 2 for video and Topaz for stills, each quoted on the original pixels. The original is kept; the upscale is a new take with its lineage."],
  ["Recover", "Nothing lost on reload", "Drafts, interrupted paid requests and lost responses come back as “Recover …”. Reusing a take loads its prompt; it never starts a paid job by itself."],
  ["Modes", "Video · Images · Audio · 3D", "One segment switches the composer. Every tool in every suite is a preset that opens it pre-configured."],
];

export default async function GenHome() {
  const prices = await sitePrices();
  const { hero, engines } = prices;
  const enhancer = prices.rateCard.find((row) => row.action === "Prompt enhancement")?.credits ?? null;
  const engine = (id: string) => engines[id];
  const ENGINES = [
    { id: SEEDANCE_25, kind: "Video", role: "Video engine", body: "Standard video. Highest fidelity, native audio, up to 30 s and 30 reference images." },
    { id: SEEDANCE_20, kind: "Video", role: "Video engine", body: "Cheaper drafts and roughs. 4 to 15 s." },
    { id: KLING_PRO, kind: "Video", role: "Video engine", body: "Water, cloth and physics-heavy motion, steadier for finals. Native audio, 3 to 15 s." },
    { id: NANO_PRO, kind: "Image", role: "Still engine", body: "Stills with legible text, up to 4K, up to 14 references." },
    { id: NANO_2, kind: "Image", role: "Still engine", body: "Quick stills at half the price. Board frames start here." },
    { id: GPT_IMAGE, kind: "Image", role: "Still engine", body: "Exact text and faithful edits. Sunburst and Flare builds, up to 10 references." },
    { id: TOPAZ, kind: "Post", role: "Finishing", body: "Creative video upscale to 4K, with frame rate and detail controls." },
  ];

  return (
    <SitePage active="gen">
      <section className="mk-hero" aria-label="Gen">
        {/* eslint-disable-next-line @next/next/no-img-element -- the campaign still, full bleed */}
        <img className="mk-hero-img" src="/campaign/hero.webp" alt="" width={1672} height={941} fetchPriority="high" />
        <div className="mk-hero-shade" aria-hidden="true" />
        <div className="mk-hero-in">
          <div className="mk-eyebrow">Gen · Video · Images · Audio · 3D</div>
          <h1 className="mk-h1 mk-hero-title">The studio&rsquo;s own room for making shots.</h1>
          <p className="mk-hero-lead">Five suites in one shell: Gen, the Production Studio, the Business Suite, the Viral Studio and the Atomik agent. Seedance, Kling and Nano Banana behind them, with the cost on every button.</p>
          <HeroPrompt model={hero.id} label={hero.name} short={hero.short} credits={hero.credits} />
        </div>
      </section>

      <Section id="gen-composer" label="Gen composer">
        <Head eyebrow="Gen · one composer" title="The cost is on the button."
          lead="One composer for video, images, audio and 3D. Every tool in every suite is a preset that opens it pre-configured; there is never a second interface." />
        <Cols col={420}>
          <Window path="particl.app / gen" src={shot("gen-composer-blank")} alt="The Gen composer" width={924} height={540} />
          <Grid col={220}>
            <Stat figure="4–30 s" name="Length by the second" body="Any whole second a video engine accepts. Ratio, resolution and audio clamp when you switch engines." />
            <Stat figure="SHA-256" name="References stay byte-identical" body="No resize, no re-encode, no metadata stripping. The rail shows ✓ BYTE-IDENTICAL when the hash matches." />
            <Stat figure={cr(enhancer)} name="Prompt enhancer" body="Rewritten in the engine's own recipe. @Image1 citations preserved; a raw: prefix sends your exact words." />
            <Stat figure="0 cr" name="Failed renders" body="Quotes are live. Only succeeded takes enter the ledger, each with the rate it was charged at." />
          </Grid>
        </Cols>
        <Cols col={420}>
          <Window path="particl.app / gen · enhance" src={shot("gen-composer-prompt-enhancer")} alt="Gen, a prompt enhancer result" width={924} height={540} />
          <Grid col={200}>
            {COMPOSER_TILES.map(([tag, name, body]) => <Tile key={tag} tag={tag} name={name} body={body} />)}
          </Grid>
        </Cols>
      </Section>

      <Section id="gen-engines" label="Engines">
        <Head eyebrow="Engines" title="Pick the engine per shot."
          lead="Studio engines in the model sheet, and the connected catalogue beside them. Settings clamp to what the engine accepts, the quote updates live, and failed renders are never billed." />
        <Grid col={250}>
          {ENGINES.map(({ id, kind, role, body }) => {
            const e = engine(id);
            return (
              <Tile key={id} tag={<span className="mk-chip mk-chip--tint">{e.short}</span>} badge={<span className="mk-tag">{kind}</span>}
                name={e.name} sub={role} body={body} price={cr(e.credits)} priceNote={e.basis} />
            );
          })}
          <Tile tag={<span className="mk-chip mk-chip--tint">11 V3</span>} badge={<span className="mk-tag">Audio</span>}
            name="Eleven v3" sub="Audio engine" body="Dialogue lines, sound effects and music sketches, straight into the Edit lanes." price="Per character" priceNote="priced by length" />
        </Grid>
      </Section>
    </SitePage>
  );
}
