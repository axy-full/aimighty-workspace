import type { Metadata } from "next";
import Link from "next/link";
import SitePage from "@/components/marketing/SitePage";
import { Chips, Cols, Grid, Head, Section, SuiteHeader, Window } from "@/components/marketing/ui";
import { SIGN_UP_HREF, shot } from "@/lib/marketing/site";
import styles from "./studio.module.css";

export const metadata: Metadata = {
  title: "Studio",
  description: "Particl Studio: a film or an ad on one board, ten stages from brief to delivery, each agentic step run by the agent you pick.",
};

/*
 * The stages as the Suites shell shows them (lib/shell/ia.ts, SHELL_SUITES
 * › studio: ten since the owner's Production brief of 23–24 September).
 * Every limit is the code's: lib/workbench/screenplay.ts (400 PDF pages),
 * lib/production/{beats,boards,environment,cast,rig-prompt}.ts,
 * lib/astra-blender/render-storage.ts (PNG · .blend · GLB), docs/sound-mix.md
 * (64 clips, stereo 48 kHz WAV), lib/workbench/movie.ts (MP4/WebM, 720p/1080p,
 * 180 s, 200 MB) and components/workspace/spec/tools/DeliverTool.tsx
 * (24/25/30 fps, CMX3600, FCPXML, Premiere XML).
 */
type Sub = { tag: string; text: string; chips: string[] };
type Stage = { title: string; text: string; chips: string[]; subs?: Sub[] };

const STAGES: Stage[] = [
  { title: "Brief & Script",
    text: "One stage for the brief and the script. The agent you pick writes the script from the brief, draft → critique → refine; send notes for another draft until you approve one. Screenplay or ad-film mode; PDF (up to 400 pages), TXT or Fountain in, with local OCR and per-page review for scans.",
    chips: ["Brief", "Script editor", "Draft → critique → refine", "Notes → redraft → approve", "Import · PDF · TXT · Fountain · OCR", "Ad-film mode", "Claude · Grok · OpenAI"] },
  { title: "Beats & Shots",
    text: "The agent breaks the approved script into scenes, beats and shots: a beat sheet you edit by hand, and the script can be redrafted to play the edited beats. Or upload a beat sheet PDF instead. Acts on a board or a graph; the shots feed Storyboards.",
    chips: ["Scenes", "Beats", "Shots", "Acts", "Board · Graph", "Beat sheet PDF", "Redraft from beats"] },
  { title: "Storyboards",
    text: "A frame for every shot on the beat sheet. The agent writes the prompts; frames render as live action, a coloured sketch or a black-and-white sketch. Upload a rough drawing and the agent reads it, so the frame keeps its blocking.",
    chips: ["Frame prompts", "Live action", "Coloured sketch", "B&W sketch", "Line drawings", "Revise selected", "Frames → Board"] },
  { title: "Environment",
    text: "Where the world is built, before the cast. The rules every place shares, then each place, from the beat sheet, the agent or by hand, with plates rendered here, uploaded or taken from the library. Plates are filed as Environment for the Board and Make.",
    chips: ["World rules", "Places", "Plates", "Render · Upload · Library", "References · up to 6", "Filed as Environment"] },
  { title: "Cast & Elements",
    text: "The cast list comes from the beat sheet, or from the agent with a prompt per entry. Characters, environments and props keep their names, prompts and reference images in one list.",
    chips: [],
    subs: [
      { tag: "CAST", text: "Characters from a prompt and a reference image.",
        chips: ["Prompt", "Reference image"] },
      { tag: "ELEMENTS · ENVIRONMENT", text: "Environments and props, listed the same way.",
        chips: ["Environment", "Prop"] },
    ] },
  { title: "3D blocking",
    text: "Blocking before rendering. A 3D scene editor, with objects, project pictures and GLB models, lights, the camera and keyframes, plus bounded planner proposals, reviewed native Blender scripts and cloud renders: a PNG still, the .blend and, where it exports, a GLB. Send a render to the Board as a new shot’s first frame.",
    chips: ["Scene editor", "Templates", "GLB in", "Proposals", "Native Blender", "Render · PNG · .blend · GLB", "Portable export", "Send to Board"] },
  { title: "Board",
    text: "Resolves references and dispatches each shot to a video engine. Build one shot per storyboard frame; each takes a prompt of up to 20,000 characters, notes, inputs from uploads, the library, earlier shots and the cast, and a first frame. List or canvas; the canvas is shared with the team.",
    chips: ["Build from Storyboards", "Prompt · 20,000 characters", "Inputs", "First frame", "List · Canvas", "Team canvas", "Build another board"] },
  { title: "Takes",
    text: "Every take of the project first, then every asset by type. A video take opens in Seedance Edit and a still is re-edited from an instruction; any take goes to the cut or starts another board. Transcribe a take, speakers apart, with subtitles.",
    chips: ["Generations", "All assets", "Seedance Edit · 2.5 · 2.0", "Re-edit a still", "Transcribe · .srt", "Add to the cut", "Build a board"] },
  { title: "Edit & Sound",
    text: "Assembles the takes, then writes dialogue, effects and music against the cut. Voice-over, sound effects and music land at the playhead; change a voice or dub one language at a time. Sixty-four timed clips with gain, pan, fades, mute and solo, mixed on the device to a stereo 48 kHz WAV.",
    chips: ["The cut", "Assembly", "Dialogue", "Sound effects", "Music", "Change voice", "Dub", "Upload a track", "Mix · 64 clips", "WAV · 48 kHz"] },
  { title: "Deliver",
    text: "Delivery runs against the spec saved on the project: 24, 25 or 30 fps, where a new rate retimes the cut, and 16:9, 9:16, 1:1 or 4:5. The final movie renders in the browser as MP4 or WebM at 720p or 1080p, up to three minutes and 200 MB. The package carries a CMX3600 straight-cut EDL, FCPXML, Premiere XML, the source media and a manifest.",
    chips: ["24 · 25 · 30 fps", "16:9 · 9:16 · 1:1 · 4:5", "Final movie · MP4 · WebM · ≤ 3 min", "EDL · CMX3600", "FCPXML · Premiere XML", "Package · ≤ 200 MB"] },
];

/* The Board's rules (the code's Rig): lib/workbench/node-graph.ts (canConnect: media-only inputs, input limits, no loops), lib/shell/drop-targets.ts, lib/shell/undo.ts. */
const NOTES: [string, string][] = [
  ["PORTS", "Direction or media. Wrong or circular wires are refused."],
  ["DROP", "Drop a picture or a take on a shot to make it an input."],
  ["VERSIONS", "Every take of a shot is a version. Undo is 20 deep."],
];

/* Two sample assets, named neutrally; labels are the stages' own (EnvironmentStage, CastStage). */
const ASSETS = [
  { src: "/campaign/environment.webp", width: 1672, height: 941, position: "50% 50%", alt: "A desert at dusk, an environment plate",
    kind: "PLACE · PLATE 2", state: "SELECTED", tone: styles.green, name: "Desert at dusk",
    line: "Environment plate · Warm daylight", acts: ["Upload a plate"] },
  { src: "/campaign/character.webp", width: 1536, height: 1024, position: "50% 20%", alt: "A lead character, a character reference",
    kind: "CAST · CHARACTER", state: "REFERENCE", tone: styles.blue, name: "Lead character",
    line: "Reference image · Three views", acts: ["Replace reference"] },
];

const pad = (i: number) => String(i + 1).padStart(2, "0");

export default function StudioPage() {
  return (
    <SitePage active="studio">
      <SuiteHeader
        eyebrow="01 · Studio"
        title="A film or an ad on one board."
        lead="Ten stages from brief to delivery. Storyboard frames come before any video, and every stage reads and writes the same production, from the brief to the final cut."
        pages={STAGES.map((stage) => stage.title)}
        cta={<>
          <a href={SIGN_UP_HREF} className="mk-btn gx-primary">Sign up</a>
          <Link href="/" className="mk-btn mk-btn--secondary">Open Make</Link>
        </>}
      />

      <Section id="studio-stages" panel label="Stages" style={{ borderTop: 0 }}>
        <Cols col={420} style={{ gap: "clamp(32px, 5vw, 72px)" }}>
          <div className={styles.left}>
            <Head eyebrow="Stages" title="One project. One library."
              lead="Pick the agent once, Claude, Grok or OpenAI, and every agentic step uses it. Every render, upload and build lands in the project’s library." />
            <ol className={styles.stages}>
              {STAGES.map((stage, i) => (
                <li key={stage.title} className={styles.stage}>
                  <span className={styles.num} aria-hidden="true">{pad(i)}</span>
                  <div className={styles.body}>
                    <h3 className={styles.title}>{stage.title}</h3>
                    <p className={styles.text}>{stage.text}</p>
                    {stage.chips.length ? <Chips items={stage.chips} /> : null}
                    {stage.subs ? (
                      <div className={styles.subs}>
                        {stage.subs.map((sub) => (
                          <div key={sub.tag} className={styles.sub}>
                            <div className={styles.tag}>{sub.tag}</div>
                            <p className={styles.subText}>{sub.text}</p>
                            <div className={styles.subChips}><Chips items={sub.chips} /></div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className={styles.aside}>
            <Window path="particl.app / production / board" src={shot("studio-rig-canvas")} alt="The board, the node graph of a shot" width={924} height={540} />
            <Grid col={220} style={{ gap: 10 }}>
              {ASSETS.map((asset) => (
                <div key={asset.name} className={styles.asset}>
                  <div className={styles.still}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- a campaign still, cropped by CSS */}
                    <img src={asset.src} alt={asset.alt} width={asset.width} height={asset.height} loading="lazy" decoding="async" style={{ objectPosition: asset.position }} />
                    <span className={`${styles.badge} ${styles.kind}`}>{asset.kind}</span>
                    <span className={`${styles.badge} ${styles.state} ${asset.tone}`}>{asset.state}</span>
                  </div>
                  <div className={styles.meta}>
                    <div className={styles.name}>{asset.name}</div>
                    <p className={styles.line}>{asset.line}</p>
                    <div className={styles.acts}>
                      {asset.acts.map((act, i) => <span key={act} className={`${styles.act}${i === 0 ? ` ${styles.actMain}` : ""}`}>{act}</span>)}
                    </div>
                  </div>
                </div>
              ))}
            </Grid>
            <Grid className={styles.notes} style={{ gap: 10 }}>
              {NOTES.map(([tag, text]) => (
                <div key={tag} className={styles.note}>
                  <div className={styles.tag}>{tag}</div>
                  <p className={styles.subText}>{text}</p>
                </div>
              ))}
            </Grid>
          </div>
        </Cols>
      </Section>
    </SitePage>
  );
}
