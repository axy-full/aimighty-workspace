import type { ReactNode } from "react";
import { eachLine, grouped, isTakeCell, nounFor, optionLabel, sortOptions, takeSettings, type PricedTake, type RateGroup, type ReachKind } from "@/lib/mediaReach";
import "./media-reach.css";

/**
 * Credits said as takes (Pricing, Billing, Workspace › Plans & credits).
 *
 * Presentational only: every figure arrives from the server already in
 * credits, priced by the composer's own quote (lib/workbench/media-reach.ts).
 */

type Reference = { video: PricedTake | null; image: PricedTake | null };

function KindMark({ kind }: { kind: ReachKind }) {
  const p = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  return (
    <span className="mr-mark" data-kind={kind}>
      {kind === "video"
        ? <svg {...p}><rect x="3" y="5" width="14" height="14" rx="2.5" /><path d="M17 10l4-2.5v9L17 14" /></svg>
        : <svg {...p}><rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="9" cy="10" r="1.8" /><path d="M21 16l-5-5-8 9" /></svg>}
    </span>
  );
}

/**
 * One kind's figure: "≈ 72" / "videos left at your usual settings" /
 * "Seedance 2.5 · 720p · 5 s · 18 cr each". `suffix` finishes the noun. The
 * count is whole takes, rounded down; nought is exact, so it carries no "≈".
 */
export function ReachTile({ kind, count, take, suffix, testId }: {
  kind: ReachKind; count: number | null; take: PricedTake | null; suffix?: string; testId?: string;
}) {
  if (count == null || !take) return null;
  const noun = `${nounFor(kind, count)}${suffix ? ` ${suffix}` : ""}`;
  const settings = `${takeSettings(take)} · ${eachLine(take)}`;
  return (
    <div className="mr-tile" role="group" data-kind={kind} data-testid={testId} aria-label={`${count > 0 ? "About " : ""}${grouped(count)} ${noun}: ${settings}`}>
      <span className="mr-tile-head" aria-hidden="true"><KindMark kind={kind} /><span className="mr-num">{count > 0 ? <>≈&nbsp;</> : null}{grouped(count)}</span></span>
      <span className="mr-noun" aria-hidden="true">{noun}</span>
      <span className="mr-set" aria-hidden="true">{settings}</span>
    </div>
  );
}

/** Two figures that are alternatives, never a sum: a video tile "or" an image tile. */
export function ReachPair({ video, image, testId }: { video: ReactNode; image: ReactNode; testId?: string }) {
  if (!video && !image) return null;
  return (
    <div className="mr-reach" data-testid={testId}>
      <div className="mr-tiles" data-pair={Boolean(video && image)}>
        {video}
        {video && image ? <span className="mr-or">or</span> : null}
        {image}
      </div>
    </div>
  );
}

/** "left at your usual settings" — or the defaults, before a workspace has made that kind of take. */
export const leftAt = (basis: "usual" | "default") => (basis === "usual" ? "left at your usual settings" : "left at the default settings");

/** A plan's monthly credits as videos or images. */
export function PlanReach({ videos, images, reference, testId }: {
  videos: number | null | undefined; images: number | null | undefined;
  reference: Reference | null | undefined; testId?: string;
}) {
  if (!reference || (videos == null && images == null)) return null;
  return (
    <ReachPair
      testId={testId}
      video={videos != null && reference.video ? <ReachTile kind="video" count={videos} take={reference.video} suffix="a month" /> : null}
      image={images != null && reference.image ? <ReachTile kind="image" count={images} take={reference.image} suffix="a month" /> : null}
    />
  );
}

const GROUP_TITLE: Record<RateGroup["axis"], string> = { resolution: "Video", size: "Images", quality: "Images by quality" };

/**
 * Credits per take for every engine: a column per size, the cell a figure
 * above was counted at outlined — and only when its price is exactly that
 * figure's, so the outline never claims a price the figure did not use.
 */
export function RateCard({ groups, reference, legend, testId }: {
  groups: RateGroup[] | null | undefined; reference?: Reference | null;
  /** What the outlined cell means here, e.g. "Plans are counted at the outlined prices." */
  legend?: string; testId?: string;
}) {
  if (!groups) return null;
  const shown = groups.filter((g) => g.rows.length);
  if (!shown.length) return <p className="mr-empty" role="status" data-testid={testId}>No engine can be priced right now. Every take is still priced on its Generate button before it runs.</p>;
  const takeOf = (group: RateGroup) => (group.kind === "video" ? reference?.video : reference?.image);
  const outlined = shown.some((group) => group.rows.some((row) => row.cells.some((cell) => isTakeCell(takeOf(group), group, row, cell))));
  const sections = shown.map((group) => {
    const columns = sortOptions([...new Set(group.rows.flatMap((r) => r.cells.map((c) => c.option)))]);
    const take = takeOf(group);
    const per = group.kind === "video" ? `cr per ${group.seconds ?? 5} s` : "cr per image";
    const title = GROUP_TITLE[group.axis] ?? (group.kind === "video" ? "Video" : "Images");
    return (
      <section key={`${group.kind}-${group.axis}`} className="mr-group" role="table" data-kind={group.kind} data-axis={group.axis} aria-label={`${title}, ${per}`} style={{ ["--mr-cols" as string]: String(columns.length), ["--mr-narrow-cols" as string]: String(Math.min(columns.length, 4)) }}>
        <div className="mr-group-head" role="row">
          <span className="mr-group-label" role="columnheader">
            <span className="mr-group-title"><KindMark kind={group.kind} />{title}</span>
            <span className="mr-group-per">{per}</span>
          </span>
          {columns.map((c) => <span key={c} className="mr-col" role="columnheader">{optionLabel(c)}</span>)}
        </div>
        {group.rows.map((row) => (
          <div key={`${row.engine}-${row.audio}`} className="mr-row" role="row" data-testid="rate-row" data-engine={row.engine} data-audio={row.audio || undefined}>
            <span className="mr-engine" role="rowheader">{row.label}{row.audio ? <span className="mr-sound"> · with sound</span> : null}</span>
            {columns.map((option) => {
              const cell = row.cells.find((c) => c.option === option);
              const marked = Boolean(cell && isTakeCell(take, group, row, cell));
              return (
                <span key={option} className="mr-cell" role="cell" data-empty={!cell || undefined} data-reference={marked || undefined} data-option={option}>
                  <span className="mr-cell-opt" aria-hidden="true">{optionLabel(option)}</span>
                  <span className="mr-cell-cr">{cell ? grouped(cell.credits) : <><span aria-hidden="true">—</span><span className="mr-sr">not offered</span></>}</span>
                </span>
              );
            })}
          </div>
        ))}
      </section>
    );
  });
  return (
    <div className="mr-card" data-testid={testId}>
      {sections}
      {legend && outlined ? <p className="mr-legend" data-testid={testId ? `${testId}-legend` : undefined}><span className="mr-legend-key" aria-hidden="true" />{legend}</p> : null}
    </div>
  );
}
