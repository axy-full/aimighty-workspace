import type { Metadata } from "next";
import Link from "next/link";
import { AtomikMark } from "@/components/AtomikMark";
import SitePage, { sitePrices } from "@/components/marketing/SitePage";
import { Amber, Chips, Cols, Dot, Grid, Head, Section, SuiteHeader, Tile, Window } from "@/components/marketing/ui";
import { ACCESS_HREF, SITE_SUITES, shot } from "@/lib/marketing/site";
import styles from "./atomik.module.css";

export const metadata: Metadata = {
  title: "Atomik Super Agent",
  description: "The production agent: it plans against your project and waits for your approval.",
};

/* Copy from lib/workspace/spec-cards.ts (Atomik), lib/workbench/atomik-server.ts
   and atomik-references.ts (what the agent reads), lib/workbench/suite-agent-plan.ts
   (proposals → Rig nodes), lib/crew/room.ts (Crew), lib/higgsfield-consumer/{tools,
   voice-tools}.ts (Generate), lib/shell/tools-connections.ts and
   lib/higgsfield-consumer/reach.ts (Tools & connections), docs/atomik-models.md
   (Models) and docs/durable-production-pipelines.md (Runs, Recipes). The public
   site states no prices: the sample plan and the recipes list their steps only. */

const AGENT_CHIPS = ["≤ 8 actions", "editable nodes", "≤ 6 visuals", "links not fetched", "each render approved"];

/* `badge` sits beside the tag (the whole page is not runnable); `gated`
   sits under the body, beside the one sentence it qualifies. */
const TILES: { tag: string; name: string; body: string; badge?: string; gated?: string }[] = [
  { tag: "01 Agent", name: "Agent",
    body: "Plain-language planning against the saved project and the references you select. Pictures and text files dropped in are filed on the project. Its actions land on Rig as editable nodes." },
  { tag: "Crew · 7 departments", name: "Crew",
    body: "Director, DOP, Production designer, Costume stylist, Editor, Producer and Continuity supervisor in one room. Each round they propose, challenge one another, and the chair converges three solutions." },
  { tag: "02 Runs", name: "Runs",
    body: "A production run is durable. Close the tab, reload or lose the connection: it keeps its place and its approved attempts, and recovery never re-dispatches." },
  { tag: "03 Generate", name: "Generate", gated: "Analyse video gated",
    body: "Image, video, sound and 3D workflows from the connected account’s catalogue. Tools: upscale image and video, remove background, extend canvas, reframe, deflicker, lip-sync. Voice: change voice and dub; Analyse video stays off." },
  { tag: "04 Recipes", name: "Recipes",
    body: "Every saved run keeps its plan: same stages, same inputs, same engines." },
  { tag: "05 Builds", name: "Builds", badge: "Not yet runnable",
    body: "The plan: describe a tool and the agent builds it, with interface, data, sign-in and generation models wired in. There is no build service yet." },
  { tag: "06 Tools", name: "Tools & connections",
    body: "What the agent reaches, and where each runs: Particl’s own engines, sound and 3D, then the connected account’s catalogue, characters, voice, dubbing, social cuts and ad templates, each checked live against the tools the account offers. A token and Particl’s own MCP server bring its tools into Claude or ChatGPT." },
  { tag: "07 Models", name: "Models",
    body: "Claude, OpenAI and Grok planners from the live catalogue, with reasoning effort and a Quick, Considered or Deep answer. Engines clamp ratio, resolution, duration and audio to what they accept; an unavailable model is never swapped silently." },
];

const WINDOWS: [string, string, string][] = [
  ["runs", "atomik-runs", "Atomik, Runs"],
  ["approvals", "atomik-approvals", "Atomik, Approvals"],
  ["tools", "atomik-tools", "Atomik, Tools & connections"],
];

export default async function AtomikPage() {
  const prices = await sitePrices();

  /* The sample plan: its steps only, since the public site states no prices. */
  const STEPS: { name: string; state: "done" | "waiting" | "idle" }[] = [
    { name: "Draft script from the brief · 3 scenes", state: "done" },
    { name: "Six board frames · Nano Banana 2 · 512", state: "waiting" },
    { name: "Four identity renders · Cast", state: "idle" },
    { name: `Hero take · ${prices.hero.name} · ${prices.hero.basis}`, state: "idle" },
  ];

  const RECIPES: { name: string; body: string; chain: string[] }[] = [
    { name: "Boards to a hero take",
      body: "Six Nano Banana 2 stills at 512 from the script, a human pick, then a 5-second 1080p Seedance 2.5 take with audio from the chosen frame, laid on a timeline.",
      chain: ["Image ×6", "Review", "Video · 5 s", "Timeline"] },
    { name: "Four takes, one pick",
      body: "One prompt from the brief, four 5-second Seedance 2.0 takes at 1080p, approved once, then a human checkpoint keeps the best.",
      chain: ["Video ×4", "One approval", "Review"] },
    { name: "Keyframe to a scored take",
      body: "A Nano Banana Pro keyframe, a 5-second Kling 3.0 Pro take from it, a music cue written from the brief, and a timeline with the cue as its soundtrack.",
      chain: ["Image", "Video", "Music", "Timeline"] },
    { name: "A line over a take",
      body: "A spoken line from the script in an Eleven v3 voice, a 5-second take to carry it, and a timeline with the line as its soundtrack.",
      chain: ["Speech", "Video", "Timeline"] },
  ];

  return (
    <SitePage active="atomik">
      <SuiteHeader
        eyebrow="05 · Atomik Super Agent"
        title="The production agent. Plans and runs the work."
        lead="Describe the outcome; the agent plans it against this project and waits for you."
        pages={SITE_SUITES.find((s) => s.id === "atomik")!.pages}
        cta={<>
          <a href={ACCESS_HREF} className="mk-btn gx-primary">Request access</a>
          <Link href="/" className="mk-btn mk-btn--secondary">Open Gen</Link>
        </>}
      />

      <Section id="atomik-agent" panel label="Agent" className={styles.agent}>
        <Cols col={400} className={styles.agentCols}>
          <div className={styles.copy}>
            <Head eyebrow="01 · Agent" title="Describe the outcome. Approve each step."
              lead="The agent reads the brief, script, direction and shot list, plus the references you select: uploaded text, images, and three sampled frames per video, six visuals at most. PDFs, audio and links count as descriptions only, and no URL is ever fetched. Its actions go to Rig as editable nodes." />
            <Chips items={AGENT_CHIPS} />
          </div>

          <figure className={styles.convo} aria-label="A sample request and the plan it returns">
            <p className={styles.bubble}>Draft the opening of Dune Studies: script from the brief, six boards, four identity renders and one hero take.</p>
            <div className={styles.plan}>
              <div className={styles.planHead}>
                <span className={styles.ring}><AtomikMark size={16} /></span>
                <span className={styles.planLabel}>PLAN · {STEPS.length} STEPS</span>
              </div>
              <ol className={styles.steps}>
                {STEPS.map((step) => (
                  <li key={step.name} className={styles.step}>
                    {step.state === "waiting"
                      ? <span className={`mk-dot ${styles.waiting}`} aria-hidden="true" />
                      : <Dot state={step.state} />}
                    <span className={styles.stepName}>{step.name}</span>
                  </li>
                ))}
              </ol>
              <div className={styles.actions} aria-hidden="true">
                <span className={`mk-btn mk-btn--sm gx-primary ${styles.still}`}>Approve</span>
                <span className={`mk-btn mk-btn--sm mk-btn--secondary ${styles.still}`}>Decline</span>
              </div>
            </div>
          </figure>
        </Cols>
      </Section>

      <Section id="atomik-pages" label="Atomik pages" className={styles.pages}>
        <Grid col={280} style={{ gap: 20 }}>
          {WINDOWS.map(([path, name, alt]) => (
            <Window key={name} path={`particl.app / atomik / ${path}`} src={shot(name)} alt={alt} width={924} height={540} />
          ))}
        </Grid>
        <Grid col={250}>
          {TILES.map(({ tag, name, body, badge, gated }) => (
            <Tile key={tag} tag={tag} badge={badge ? <Amber>{badge.toUpperCase()}</Amber> : undefined} name={name} body={body}>
              {gated && <div className={styles.gated}><Amber>{gated.toUpperCase()}</Amber></div>}
            </Tile>
          ))}
        </Grid>
      </Section>

      <Section id="atomik-recipes" panel label="Recipes">
        <Head eyebrow="04 · Recipes" title="Saved plans that rerun exactly."
          lead="Every saved run keeps its plan. Save one as a file to keep it." />
        {/* 260, not the design's 280: this wrap is 1120 wide, so 280 would
            leave a 3 + 1 row at desktop; 260 keeps four across there and
            two by two at 844, as the design does. */}
        <Grid col={260}>
          {RECIPES.map((recipe, i) => (
            <Tile key={recipe.name} className={styles.recipe} tag={`Example ${String(i + 1).padStart(2, "0")}`}
              name={recipe.name} body={recipe.body}>
              <div className={styles.chain}><Chips items={recipe.chain} /></div>
              <span className={styles.foot}>New run · exact plan</span>
            </Tile>
          ))}
        </Grid>
      </Section>
    </SitePage>
  );
}
