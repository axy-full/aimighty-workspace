import type { Metadata } from "next";
import Link from "next/link";
import SitePage from "@/components/marketing/SitePage";
import { Cols, Grid, Head, Section, SuiteHeader, Tile, Window } from "@/components/marketing/ui";
import { ACCESS_HREF, shot } from "@/lib/marketing/site";
import styles from "./studio.module.css";

export const metadata: Metadata = {
  title: "Studio",
  description: "Studio is one board, from brief to delivery. Atomik plans and prices each step, and a person approves.",
};

/*
 * The board's regions, in the order its rail shows them (lib/board/regions.ts,
 * STUDIO_RAIL). One line each, from what its cards hold today
 * (components/graphite/board/cards): the brief document, the look boards, the
 * storyboard frames, the shot takes, the cast, environment and element cards,
 * the cut card and the deliver card.
 */
const REGIONS: { title: string; text: string }[] = [
  { title: "Brief", text: "What you are making and the look, written in place on the board." },
  { title: "Looks", text: "Look boards for the film. Pick one and the storyboard is drawn in it." },
  { title: "Storyboard", text: "A frame for every shot. Approve the frames to make the shots." },
  { title: "Shots", text: "The takes of each shot, to compare, pick and approve." },
  { title: "Cast", text: "Characters, places and props, each kept with its reference. A character can be trained as an identity." },
  { title: "Cut", text: "The approved takes in order on a short timeline, with the editor one press away." },
  { title: "Deliver", text: "Checks the cut’s aspect, frame rate and length, then exports it from your browser. Free." },
];

/* The two campaign stills the site already ships, as board cards. Placeholder names only. */
const CARDS = [
  { src: "/campaign/environment.webp", width: 1672, height: 941, position: "50% 50%", alt: "An environment plate",
    kind: "ENVIRONMENT", name: "A 15-second film", line: "Environment plate" },
  { src: "/campaign/character.webp", width: 1536, height: 1024, position: "50% 20%", alt: "A character reference",
    kind: "CAST", name: "Lead · ivory suit, short dark bob", line: "Reference image" },
];

const pad = (i: number) => String(i + 1).padStart(2, "0");

export default function StudioPage() {
  return (
    <SitePage active="studio">
      <SuiteHeader
        eyebrow="01 · Studio"
        title="One board, from brief to delivery."
        lead="The whole production on one canvas. Atomik plans each step and shows its price; a person approves."
        pages={REGIONS.map((region) => region.title)}
        cta={<>
          <a href={ACCESS_HREF} className="mk-btn gx-primary">Request access</a>
          <Link href="/" className="mk-btn mk-btn--secondary">Open Make</Link>
        </>}
      />

      <Section id="studio-board" panel label="The board" style={{ borderTop: 0 }}>
        <Cols col={420} style={{ gap: "clamp(32px, 5vw, 72px)" }}>
          <div className={styles.left}>
            <Head eyebrow="The board" title="Seven regions. One project." />
            <ol className={styles.stages}>
              {REGIONS.map((region, i) => (
                <li key={region.title} className={styles.stage}>
                  <span className={styles.num} aria-hidden="true">{pad(i)}</span>
                  <div className={styles.body}>
                    <h3 className={styles.title}>{region.title}</h3>
                    <p className={styles.text}>{region.text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <Grid col={240} style={{ gap: 10 }}>
              <Tile tag="Atomik" name="Plans and prices every step" body="Describe the outcome. Atomik lays out the steps with their prices, and a person approves before anything is spent." />
              <Tile tag="Make" name="Over any screen" body="Video, images and audio from any region, with the engine and price on the button." />
            </Grid>
          </div>

          <div className={styles.aside}>
            <Window path="particl.si / a-15-second-film / board" src={shot("board-canvas")} alt="The Studio board: the rail of regions, the cards and the tool row" width={924} height={540} />
            <Grid col={220} style={{ gap: 10 }}>
              {CARDS.map((card) => (
                <div key={card.name} className={styles.asset}>
                  <div className={styles.still}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- a campaign still, cropped by CSS */}
                    <img src={card.src} alt={card.alt} width={card.width} height={card.height} loading="lazy" decoding="async" style={{ objectPosition: card.position }} />
                    <span className={`${styles.badge} ${styles.kind}`}>{card.kind}</span>
                  </div>
                  <div className={styles.meta}>
                    <div className={styles.name}>{card.name}</div>
                    <p className={styles.line}>{card.line}</p>
                  </div>
                </div>
              ))}
            </Grid>
          </div>
        </Cols>
      </Section>
    </SitePage>
  );
}
