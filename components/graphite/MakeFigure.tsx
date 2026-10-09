"use client";
import { Price, usePriceTitle } from "./Price";
import type { MakeFigure } from "@/lib/shell/make-price";

/**
 * A price as Make draws it (lib/shell/make-price.ts): an exact figure through the shared Price ("43 cr", dollars on
 * hover), or Cinema Studio's approximate one in its runs of words. Each run is one unbreakable piece, so a narrow
 * control moves a run whole onto the next line and never cuts a figure.
 */
export function MakeFigureView({ figure, className, testId }: { figure: MakeFigure | null; className?: string; testId?: string }) {
  if (!figure) return null;
  if (figure.kind === "exact") return <Price value={figure.value} className={className} testId={testId} />;
  return (
    <span className={className ? `gx-price ${className}` : "gx-price"} data-price="approximate" data-testid={testId}>
      {figure.parts.map((part, i) => <span key={i} style={{ whiteSpace: "nowrap" }}>{i ? " " : ""}{part}</span>)}
    </span>
  );
}

/** The dollars-on-hover title for a control whose label carries `figure` ("Make · 43 cr"); null for an approximate one or an unknown rate. */
export function useFigureTitle(figure: MakeFigure | null): string | undefined {
  const title = usePriceTitle(figure && figure.kind === "exact" ? figure.value : null);
  return title ?? undefined;
}
