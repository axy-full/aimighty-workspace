"use client";

import type { ReactNode } from "react";
import { ACCESS_HREF } from "@/lib/marketing/links";
import s from "./pricing.module.css";

/** One plan card, already worded on the server (planLines, PLAN_AUDIENCE). `price` is the figure as it reads ("$50", "from $100"); none for Enterprise. */
export type PlanCard = { id: string; label: string; price: string | null; unit: string; audience: string; lines: string[]; cta: string; badge?: string };

/** "500 credits a month" → the figure in bold, the rest plain. */
function Line({ text }: { text: string }) {
  const m = /^([\d,]+ credits)(.*)$/.exec(text);
  return m ? <li><strong>{m[1]}</strong>{m[2]}</li> : <li>{text}</li>;
}

function Card({ plan }: { plan: PlanCard }) {
  const hl = Boolean(plan.badge);
  return (
    <div className={`mk-card ${s.plan}${hl ? ` mk-card--hl ${s.planHl}` : ""}`} data-plan={plan.id}>
      <div className={s.planTop}>
        <span className={`mk-tag${hl ? "" : " mk-tag--muted"}`}>{plan.label}</span>
        {plan.badge && <span className={s.badge}>{plan.badge}</span>}
      </div>
      <div>
        <div className={s.price}>{plan.price ?? "Get in touch"}{plan.price && plan.unit && <small>{plan.unit}</small>}</div>
        <div className={s.billing}>{plan.price ? "billed monthly" : ""}</div>
      </div>
      <p className={s.audience}>{plan.audience}</p>
      <ul className={s.lines}>
        {plan.lines.map((line) => <Line key={line} text={line} />)}
      </ul>
      <a href={ACCESS_HREF} className={`mk-btn ${s.cta} ${hl ? "gx-primary" : "mk-btn--secondary"}`}>{plan.cta}</a>
    </div>
  );
}

/**
 * The plan cards, monthly only: one person's three plans, then a team's card (priced a seat, from its lowest level)
 * and Enterprise ("Get in touch", no price). The head (eyebrow, title, lead) arrives server-rendered.
 */
export default function PlanCards({ individual, team, children }: { individual: PlanCard[]; team: PlanCard[]; children: ReactNode }) {
  return (
    <>
      <div className={s.head}>{children}</div>
      <h2 className={`mk-h3 ${s.group}`}>For one person</h2>
      <div className={`mk-grid ${s.three} ${s.planGrid}`} data-testid="plans-individual">
        {individual.map((plan) => <Card key={plan.id} plan={plan} />)}
      </div>
      <h2 className={`mk-h3 ${s.group}`}>For a team</h2>
      <div className={`mk-grid ${s.three} ${s.planGrid}`} data-testid="plans-team">
        {team.map((plan) => <Card key={plan.id} plan={plan} />)}
      </div>
    </>
  );
}
