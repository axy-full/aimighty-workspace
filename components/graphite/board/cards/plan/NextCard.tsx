"use client";
import { useMemo } from "react";
import { Price } from "@/components/graphite/Price";
import { lookPrompt, lookRequest } from "@/lib/production/looks";
import { useStageQuotes } from "@/lib/production/use-stage-quotes";
import { exact } from "@/lib/shell/price-words";
import { useShell } from "@/lib/shell/state";
import { generationRequestBody } from "@/lib/workbench/generation-request";
import type { CardProps } from "../types";
import { nextPreset, type NextChoice } from "./next";
import "./plan.css";

/** One of "Where to next?"'s cards (README § 3.1 j): an icon, the name over its line, and a way in. */
export type NextData = NextChoice;
export const NEXT_CARD_SIZE = { w: 308, h: 120 } as const;

export function NextCard({ data, ctx }: CardProps<NextData>) {
  const shell = useShell();
  const aspect = ctx.project.aspect;
  /* The stills card carries the server's price for one still ("N cr each"); it is read, never sent. */
  const request = useMemo((): Record<string, { body: Record<string, unknown> }> => {
    if (data.id !== "stills") return {};
    const input = lookRequest(ctx.project, { prompt: lookPrompt(ctx.project, { id: "next", name: "", words: "A campaign still" }) }, null);
    return input ? { still: { body: generationRequestBody(input) } } : {};
  }, [data.id, ctx.project]);
  const quotes = useStageQuotes(ctx.scope, request);
  const credits = quotes.quotes.still?.credits;
  const open = () => {
    /* Crew review is the board's own panel (frame m). */
    if (data.id === "crew") { shell.goBoard({ frame: "m" }); return; }
    const p = nextPreset(data.id, aspect);
    shell.openMake({ prompt: "", type: p.type, note: p.note, picks: p.picks });
  };
  return (
    <button type="button" className="gx-next nodrag" onClick={open} disabled={ctx.offline} data-testid={`board-next-${data.id}`}>
      <svg className="gx-next-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={data.icon} /></svg>
      <span className="gx-next-name">{data.name}</span>
      <span className="gx-next-line">
        {data.line}
        {data.id === "stills" && credits != null ? <> · <Price value={exact(credits)} /> each</> : null}
      </span>
    </button>
  );
}
