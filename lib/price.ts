"use client";

/**
 * Money, in whatever this workspace pays in.
 *
 * A workspace on the platform's keys buys credits, and every figure it
 * sees is in whole credits at the engine's margin, rounded up — the rule
 * the metering layer bills by. The studio's own workspace and one on its
 * own keys pay their vendors in dollars and see dollars. A list is summed
 * take by take, never rounded once at the end; a server aggregate carries
 * both units and the hook picks the workspace's.
 */
import { useMemo } from "react";
import { useSession } from "@/lib/session";
import { usd } from "@/lib/format";
import { billCreditsWith, marginFor, marginKeyOf } from "@/lib/creditTerms";

/** A finished take: what the engine charged, plus the prompt writer's share. */
export type Priced = {
  costUsd: number | null | undefined;
  refineCostUsd?: number | null;
  kind?: string | null;
  model?: string | null;
};
/** A server aggregate that carries both units. */
export type Amount = { spend?: number | null; credits?: number | null };

export type Money = {
  inCredits: boolean;
  /** A job priced before it runs, by engine. */
  price: (usdAmount: number, engine?: string | null) => string;
  /** A rate — per second, per still — left unrounded. */
  rate: (usdAmount: number, engine?: string | null) => string;
  /** What a finished take cost, all-in. */
  take: (g: Priced) => string;
  takeCredits: (g: Priced) => number;
  /** A list of takes, summed take by take. */
  sum: (list: Priced[]) => string;
  /** A server aggregate. */
  of: (v: Amount) => string;
  /** An aggregate shared out over n things. */
  each: (v: Amount, n: number) => string;
  /** A projection from dollars; approximate in credits. */
  approx: (usdAmount: number) => string;
};

const cr = (n: number) => `${Math.round(n).toLocaleString("en-US")} cr`;

/** Credits as a number for a sentence: whole above ten, one decimal under. */
export function creditsNumber(n: number): string {
  if (n > 0 && n < 0.05) return "<0.1";
  const v = Math.abs(n) < 10 ? Math.round(n * 10) / 10 : Math.round(n);
  return v.toLocaleString("en-US");
}

export const fmtCredits = (n: number): string => `${creditsNumber(n)} cr`;

export function useMoney(): Money {
  const { credits } = useSession();
  return useMemo<Money>(() => {
    if (!credits) {
      const all = (g: Priced) => (g.costUsd ?? 0) + (g.refineCostUsd ?? 0);
      return {
        inCredits: false,
        price: (n) => (n > 0 && n < 0.005 ? "<1¢" : usd(n, 2)),
        rate: (n) => usd(n, 3),
        take: (g) => usd(all(g), 2),
        takeCredits: () => 0,
        sum: (list) => usd(list.reduce((a, g) => a + all(g), 0), 2),
        of: (v) => usd(v.spend ?? 0, 2),
        each: (v, n) => (n > 0 ? usd((v.spend ?? 0) / n, 2) : "—"),
        approx: (n) => usd(n, 0),
      };
    }
    const { creditUsd: per, margins } = credits;
    const bill = (n: number, engine?: string | null) => billCreditsWith(n, marginFor(engine, margins), per);
    const takeCredits = (g: Priced) => bill((g.costUsd ?? 0) + (g.refineCostUsd ?? 0), marginKeyOf(g.kind, g.model));
    const ofCredits = (v: Amount) => v.credits ?? Math.ceil(((v.spend ?? 0) * marginFor("*", margins)) / per);
    return {
      inCredits: true,
      price: (n, engine) => cr(bill(n, engine)),
      rate: (n, engine) => `${((n * marginFor(engine, margins)) / per).toFixed(1)} cr`,
      take: (g) => cr(takeCredits(g)),
      takeCredits,
      sum: (list) => cr(list.reduce((a, g) => a + takeCredits(g), 0)),
      of: (v) => cr(ofCredits(v)),
      each: (v, n) => (n > 0 ? cr(ofCredits(v) / n) : "—"),
      approx: (n) => `≈ ${cr((n * marginFor("*", margins)) / per)}`,
    };
  }, [credits]);
}

/** The price on a button. */
export function usePrice(): Money["price"] {
  return useMoney().price;
}
