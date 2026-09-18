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
import { providerCreditQuote, formatProviderCreditQuote, sumWithProviderCreditQuotes, type ProviderCreditQuote } from "./providerCreditQuote";


/** A finished take: what the engine charged, plus the prompt writer's share. */
export type Priced = {
  costUsd: number | null | undefined;
  refineCostUsd?: number | null;
  kind?: string | null;
  model?: string | null;
  /** What the ledger billed, in credits. The server's figure, not a
   *  conversion done here — the browser has no margin to convert with. */
  creditsBilled?: number | null;
  providerCreditQuote?: ProviderCreditQuote | null;
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
  const { rates } = useSession();
  return useMemo<Money>(() => {
    /* Dollars, for a workspace that pays its vendors in them. The figures
       arrive already in dollars — the server built the table that way — so
       nothing here converts and nothing here knows a margin.
       
       THE UNIT IS THE TABLE'S, and only the table's. This used to read
       `!credits || rates.unit === "usd"`, which meant a VISITOR — who has no
       credit balance because they have no workspace — got the dollar
       formatter applied to a credit table. The signed-out composer read
       "$39.81" for a shot that costs 40 credits: not the vendor's dollars,
       not the price, just a credit figure with a dollar sign in front of it.
       A balance says what somebody HAS; it was never what they pay in. */
    if (rates.unit === "usd") {
      const all = (g: Priced) => (g.costUsd ?? 0) + (g.refineCostUsd ?? 0);
      return {
        inCredits: false,
        price: (n) => (n > 0 && n < 0.005 ? "<1¢" : usd(n, 2)),
        rate: (n) => usd(n, 3),
        take: (g) => { const quote = providerCreditQuote(g.providerCreditQuote); return quote ? formatProviderCreditQuote(quote) : usd(all(g), 2); },
        takeCredits: () => 0,
        sum: (list) => sumWithProviderCreditQuotes(list, standard => usd(standard.reduce((a, g) => a + all(g), 0), 2)),
        of: (v) => usd(v.spend ?? 0, 2),
        each: (v, n) => (n > 0 ? usd((v.spend ?? 0) / n, 2) : "—"),
        approx: (n) => usd(n, 0),
      };
    }
    /* Credits. Every figure that reaches this hook is ALREADY in credits:
       estimates come off the rate table the server converted, and a finished
       take's credits come off the ledger, which did the conversion when it
       billed. So this rounds and formats, and that is all it does.

       It used to convert — `billCreditsWith(usd, marginFor(engine, margins), per)`
       — which meant the browser held both the vendor's dollars and the margin,
       and `credits × 0.10 ÷ margin` gave up the markup exactly. */
    const whole = (n: number) => (n > 0 ? Math.max(1, Math.ceil(n - 1e-9)) : 0);
    const takeCredits = (g: Priced) => providerCreditQuote(g.providerCreditQuote) ? 0 : Math.round(g.creditsBilled ?? 0);
    const ofCredits = (v: Amount) => v.credits ?? 0;
    return {
      inCredits: true,
      price: (n) => cr(whole(n)),
      rate: (n) => `${n.toFixed(1)} cr`,
      take: (g) => { const quote = providerCreditQuote(g.providerCreditQuote); return quote ? formatProviderCreditQuote(quote) : cr(takeCredits(g)); },
      takeCredits,
      sum: (list) => sumWithProviderCreditQuotes(list, standard => cr(standard.reduce((a, g) => a + takeCredits(g), 0))),
      of: (v) => cr(ofCredits(v)),
      each: (v, n) => (n > 0 ? cr(ofCredits(v) / n) : "—"),
      approx: (n) => `≈ ${cr(whole(n))}`,
    };
  }, [rates]);
}

/** The price on a button. */
export function usePrice(): Money["price"] {
  return useMoney().price;
}
