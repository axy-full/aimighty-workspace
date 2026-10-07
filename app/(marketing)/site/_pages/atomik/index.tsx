import type { Metadata } from "next";
import Link from "next/link";
import { AtomikMark } from "@/components/AtomikMark";
import SitePage, { sitePrices } from "@/components/marketing/SitePage";
import { Chips, Cols, Dot, Grid, Head, Section, SuiteHeader, Tile } from "@/components/marketing/ui";
import { ACCESS_HREF, SITE_SUITES } from "@/lib/marketing/site";
import styles from "./atomik.module.css";

export const metadata: Metadata = {
  title: "Atomik Agent",
  description: "The production agent: it plans against your project, shows each step's price and waits for your approval.",
};

/* What the page says is what Atomik holds today: the plan card
   (components/graphite/board/cards/plan), the panel (components/graphite/atomik/panel)
   and the four pages of its control room (components/graphite/control-room:
   Approvals, Activity, Skills, Memory). Limits: lib/workbench/suite-agent-plan.ts
   (8 actions) and lib/workbench/atomik-reference-types.ts (6 visuals). The public
   site states no prices: the sample plan lists its steps only. */

const AGENT_CHIPS = ["≤ 8 actions", "≤ 6 visuals", "each step priced", "each render approved"];

const TILES: { tag: string; name: string; body: string }[] = [
  { tag: "01 Approvals", name: "Approvals",
    body: "One queue across every project. Approve each item at its own price, or everything under a figure in one go." },
  { tag: "02 Activity", name: "Activity",
    body: "Every run and what it settled, in credits, by project. A run waiting for a person is approved in Approvals." },
  { tag: "03 Skills", name: "Skills",
    body: "Save a run and run it again with new words. Each step still waits for its own approval." },
  { tag: "04 Memory", name: "Memory",
    body: "What Atomik keeps in mind for a project and for your team: brand, audience, references and cast. Add a line or forget one any time." },
];

export default async function AtomikPage() {
  const prices = await sitePrices();

  /* The sample plan: its steps only, since the public site states no prices. */
  const STEPS: { name: string; state: "done" | "waiting" | "idle" }[] = [
    { name: "Six board frames · Nano Banana 2 · 512", state: "waiting" },
    { name: `Hero take · ${prices.hero.name} · ${prices.hero.basis}`, state: "idle" },
  ];

  return (
    <SitePage active="atomik">
      <SuiteHeader
        eyebrow="05 · Atomik Agent"
        title="The production agent. Plans the work, you approve it."
        lead="Describe the outcome; the agent plans it against this project, prices each step and waits for you."
        pages={SITE_SUITES.find((s) => s.id === "atomik")!.pages}
        cta={<>
          <a href={ACCESS_HREF} className="mk-btn gx-primary">Request access</a>
          <Link href="/" className="mk-btn mk-btn--secondary">Open Make</Link>
        </>}
      />

      <Section id="atomik-agent" panel label="Agent" className={styles.agent}>
        <Cols col={400} className={styles.agentCols}>
          <div className={styles.copy}>
            <Head eyebrow="01 · Agent" title="Describe the outcome. Approve each step."
              lead="The agent reads the brief and the references you select, six visuals at most. Its plan lands on the board, and nothing is spent until a person approves." />
            <Chips items={AGENT_CHIPS} />
          </div>

          <figure className={styles.convo} aria-label="A sample request and the plan it returns">
            <p className={styles.bubble}>Make the opening of A 15-second film: six board frames and one hero take.</p>
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
                <span className={`mk-btn mk-btn--sm mk-btn--secondary ${styles.still}`}>Change</span>
              </div>
            </div>
          </figure>
        </Cols>
      </Section>

      <Section id="atomik-pages" label="Atomik pages" className={styles.pages}>
        <Grid col={250}>
          {TILES.map(({ tag, name, body }) => (
            <Tile key={tag} tag={tag} name={name} body={body} />
          ))}
        </Grid>
      </Section>
    </SitePage>
  );
}
