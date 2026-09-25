"use client";

import { useState, type ReactNode } from "react";
import { usd } from "@/lib/marketing/format";
import { ACCESS_HREF } from "@/lib/marketing/site";
import s from "./pricing.module.css";

/** One plan card, already worded on the server (planLines, PLAN_AUDIENCE). */
export type PlanCard = { id: string; label: string; priceUsd: number; audience: string; lines: string[] };

/** "400 credits a month" → the figure in bold, the rest plain. */
function Line({ text }: { text: string }) {
  const m = /^([\d,]+ credits)(.*)$/.exec(text);
  return m ? <li><strong>{m[1]}</strong>{m[2]}</li> : <li>{text}</li>;
}

/**
 * The Monthly | Yearly control and the four plan cards it reprices. Yearly
 * shows the monthly equivalent of an annual subscription, the same figure
 * checkout charges (lib/billingConfig.ts): the monthly price less the annual
 * discount. The head (eyebrow, title, lead) arrives server-rendered.
 */
export default function PlanCards({ plans, discountPercent, children }: {
  plans: PlanCard[]; discountPercent: number; children: ReactNode;
}) {
  const [yearly, setYearly] = useState(false);
  const factor = yearly ? 1 - discountPercent / 100 : 1;
  const note = yearly ? `billed yearly · ${discountPercent}% off` : "billed monthly";

  return (
    <>
      <div className={s.head}>
        {children}
        <div className={s.seg} role="group" aria-label="Billing period">
          <button type="button" aria-pressed={!yearly} onClick={() => setYearly(false)}>Monthly</button>
          <button type="button" aria-pressed={yearly} onClick={() => setYearly(true)}>
            Yearly{discountPercent > 0 && <span className={s.off}>&minus;{discountPercent}%</span>}
          </button>
        </div>
      </div>

      <div className={`mk-grid ${s.four} ${s.planGrid}`}>
        {plans.map((plan) => {
          const hl = plan.id === "agency";
          const invite = plan.id === "invite";
          const paid = plan.priceUsd > 0;
          const price = Math.round(plan.priceUsd * factor * 100) / 100;
          return (
            <div key={plan.id} className={`mk-card ${s.plan}${hl ? ` mk-card--hl ${s.planHl}` : ""}`}>
              <div className={s.planTop}>
                <span className={`mk-tag${hl ? "" : " mk-tag--muted"}`}>{plan.label}</span>
                {hl && <span className={s.badge}>Most teams</span>}
              </div>
              <div>
                <div className={s.price}>{usd(price)}{paid && <small>/mo</small>}</div>
                <div className={s.billing}>{invite ? "one-time grant" : paid ? note : ""}</div>
              </div>
              <p className={s.audience}>{plan.audience}</p>
              <ul className={s.lines}>
                {plan.lines.map((line) => <Line key={line} text={line} />)}
              </ul>
              <a href={ACCESS_HREF} className={`mk-btn ${s.cta} ${hl ? "gx-primary" : "mk-btn--secondary"}`}>
                {plan.id === "production" ? "Talk to us" : "Request access"}
              </a>
            </div>
          );
        })}
      </div>
    </>
  );
}
