"use client";
import { useEffect, useState } from "react";
import { Segment } from "@/components/v12/ui/Segment";
import { BUSINESS, ENTERPRISE, businessFrom, businessLevels, individualCards, seatTotal } from "@/lib/planCards";
import { DEFAULT_PLANS, cleanPlans, planById, type PlanDef } from "@/lib/plans";
import "./plan-picker.css";

/**
 * The plans in the new interface (prototype v14), in Settings › Credits & billing and on the new-workspace "Choose a plan" step: a
 * toggle Individual · Business; Individual cards with their one line; Business ("from" the lowest level per seat) with its three levels
 * and a seats stepper that shows the total; Enterprise ("Get in touch", no price). Every name, price, credit figure and line is
 * the platform console's layer of lib/plans.ts (through lib/planCards.ts), the one the public site and /pricing read; nothing is typed
 * here. The screen that has the layer already passes it; otherwise it is read from GET /api/plans (public). Display only: Choose opens
 * nothing that charges.
 */
function usePlanLayer(given: readonly unknown[] | undefined): PlanDef[] {
  const [read, setRead] = useState<PlanDef[] | null>(null);
  useEffect(() => {
    if (given) return;
    let live = true;
    fetch("/api/plans", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j: { plans?: unknown } | null) => {
      if (live && Array.isArray(j?.plans)) setRead(cleanPlans(j.plans));
    }).catch(() => { /* the defaults stay */ });
    return () => { live = false; };
  }, [given]);
  return given ? cleanPlans(given) : read ?? DEFAULT_PLANS;
}

const money = (usd: number) => `$${usd.toLocaleString("en-US")}`;
const count = (n: number) => n.toLocaleString("en-US");

export function PlanPicker({ plans, current = null, selected = null, chooseLabel = "Choose", onChoose }: {
  /** The platform layer's plans, when the screen has them (Settings reads them with the billing); else read here. */
  plans?: readonly unknown[];
  /** The plan the workspace is on, shown as "Current plan". */
  current?: string | null;
  /** A plan picked in a flow that keeps a choice (the join sheet). */
  selected?: string | null;
  chooseLabel?: string;
  onChoose: (planId: string) => void;
}) {
  const layer = usePlanLayer(plans);
  const INDIVIDUAL_CARDS = individualCards(layer);
  const BUSINESS_LEVELS = businessLevels(layer);
  const BUSINESS_FROM_USD = businessFrom(layer);
  const business = (id: string | null) => BUSINESS_LEVELS.some((l) => l.id === id);
  const [group, setGroup] = useState<"individual" | "business">(business(current ?? selected) ? "business" : "individual");
  const [chosenLevel, setLevel] = useState<string | null>(business(current ?? selected) ? (current ?? selected) : null);
  const [seats, setSeats] = useState<number>(BUSINESS.seats.initial);
  /* A level the layer no longer offers falls back to its first. */
  const level = chosenLevel && business(chosenLevel) ? chosenLevel : BUSINESS_LEVELS[0]?.id ?? "";
  const levelPlan = planById(layer, level) ?? layer.find((p) => p.id === BUSINESS_LEVELS[0]?.id) ?? DEFAULT_PLANS.find((p) => p.group === "business")!;
  const total = seatTotal(levelPlan, seats);
  const action = (id: string) => (
    <button type="button" className="v12-pp-btn" disabled={current === id} aria-pressed={selected === id || undefined} onClick={() => onChoose(id)} data-testid="v12-plan-choose">
      {current === id ? "Current plan" : selected === id ? "Chosen" : chooseLabel}
    </button>
  );

  return (
    <div className="v12-pp" data-testid="v12-plan-picker" data-group={group}>
      <div className="v12-pp-head">
        <Segment label="Plans for" size="sm" value={group} onChange={setGroup}
          options={[{ id: "individual", label: "Individual" }, { id: "business", label: BUSINESS.label }]} />
      </div>

      {group === "individual" ? (
        <div className="v12-pp-cards" data-testid="v12-plans-individual">
          {INDIVIDUAL_CARDS.map((card) => (
            <div key={card.id} className="v12-pp-card" data-testid="v12-plan-card" data-plan={card.id} data-current={current === card.id || undefined}>
              <span className="v12-pp-name">{card.name}</span>
              <span className="v12-pp-price">{money(card.priceUsd)}<small>/month</small></span>
              <span className="v12-pp-credits">{count(card.credits)} credits</span>
              {card.blurb ? <span className="v12-pp-line">{card.blurb}</span> : null}
              {action(card.id)}
            </div>
          ))}
        </div>
      ) : (
        <div className="v12-pp-business" data-testid="v12-plans-business">
          <h3 className="v12-pp-h">{BUSINESS.label} — from {money(BUSINESS_FROM_USD)} per seat</h3>
          <p className="v12-pp-line">{BUSINESS.note}</p>
          <div className="v12-pp-cards">
            {BUSINESS_LEVELS.map((l) => (
              <button key={l.id} type="button" className="v12-pp-card v12-pp-level" aria-pressed={level === l.id} onClick={() => setLevel(l.id)} data-testid="v12-plan-level" data-plan={l.id} data-current={current === l.id || undefined}>
                <span className="v12-pp-name">{l.name}</span>
                <span className="v12-pp-price">{money(l.perSeatUsd)}<small>per seat/month</small></span>
                <span className="v12-pp-credits">{count(l.perSeatCredits)} credits per seat</span>
              </button>
            ))}
          </div>
          <div className="v12-pp-seats" role="group" aria-label="Seats">
            <button type="button" className="v12-pp-step" aria-label="Fewer seats" disabled={seats <= BUSINESS.seats.min} onClick={() => setSeats((n) => Math.max(BUSINESS.seats.min, n - 1))} data-testid="v12-plan-seats-less">−</button>
            <span className="v12-pp-total" role="status" data-testid="v12-plan-seats-total">{total.seats} {total.seats === 1 ? "seat" : "seats"} · {money(total.usd)}/month · {count(total.credits)} credits</span>
            <button type="button" className="v12-pp-step" aria-label="More seats" disabled={seats >= BUSINESS.seats.max} onClick={() => setSeats((n) => Math.min(BUSINESS.seats.max, n + 1))} data-testid="v12-plan-seats-more">+</button>
            {action(level)}
          </div>
        </div>
      )}

      <div className="v12-pp-enterprise" data-testid="v12-plan-enterprise">
        <span className="v12-pp-name">{ENTERPRISE.label} — {ENTERPRISE.blurb}</span>
        <button type="button" className="v12-pp-btn" onClick={() => onChoose(ENTERPRISE.id)}>{ENTERPRISE.line}</button>
      </div>
    </div>
  );
}
