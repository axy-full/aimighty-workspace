import { grouped, nounFor, optionLabel, sortOptions, takeSettings, type PricedTake, type RateGroup, type ReachKind } from "@/lib/mediaReach";
import "./media-reach.css";

/**
 * Credits said as takes (Pricing, Billing, Workspace › Plans & credits).
 *
 * Presentational only: every figure arrives from the server already in
 * credits, priced by the composer's own quote (lib/workbench/media-reach.ts).
 */

function KindMark({ kind }: { kind: ReachKind }) {
  const p = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  return (
    <span className="mr-mark" data-kind={kind}>
      {kind === "video"
        ? <svg {...p}><rect x="3" y="5" width="14" height="14" rx="2.5" /><path d="M17 10l4-2.5v9L17 14" /></svg>
        : <svg {...p}><rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="9" cy="10" r="1.8" /><path d="M21 16l-5-5-8 9" /></svg>}
    </span>
  );
}

/**
 * One kind's figure: "≈ 22 videos · Seedance 2.5 · 720p · 5 s".
 * `suffix` finishes the noun ("left"); `note` sits under the settings.
 */
export function ReachTile({ kind, count, take, suffix, note, testId }: {
  kind: ReachKind; count: number | null; take: PricedTake | null; suffix?: string; note?: string; testId?: string;
}) {
  if (count == null || !take) return null;
  const noun = `${nounFor(kind, count)}${suffix ? ` ${suffix}` : ""}`;
  const settings = `${takeSettings(take)} · ${grouped(take.credits)} cr each`;
  return (
    <div className="mr-tile" role="group" data-kind={kind} data-testid={testId} title={settings} aria-label={`About ${grouped(count)} ${noun}${note ? ` ${note}` : ""}: ${settings}`}>
      <span className="mr-tile-head"><KindMark kind={kind} /><span className="mr-num">≈ {grouped(count)}</span></span>
      <span className="mr-noun">{noun}</span>
      <span className="mr-set">{takeSettings(take)}</span>
      {note ? <span className="mr-note">{note}</span> : null}
    </div>
  );
}

/** A plan's monthly credits as videos and images, side by side. */
export function PlanReach({ videos, images, reference, testId }: {
  videos: number | null | undefined; images: number | null | undefined;
  reference: { video: PricedTake | null; image: PricedTake | null } | null | undefined; testId?: string;
}) {
  if (!reference || (videos == null && images == null)) return null;
  return (
    <div className="mr-tiles" data-testid={testId}>
      <ReachTile kind="video" count={videos ?? null} take={reference.video} />
      <ReachTile kind="image" count={images ?? null} take={reference.image} />
    </div>
  );
}

const isReference = (take: PricedTake | null | undefined, engine: string, option: string) => Boolean(take && take.engine === engine && take.resolution === option);

/**
 * Credits per take for every engine: a column per size, the reference
 * engine's cell outlined so a plan's figure can be traced to its price.
 */
export function RateCard({ groups, reference, legend, testId }: {
  groups: RateGroup[] | null | undefined; reference?: { video: PricedTake | null; image: PricedTake | null } | null;
  /** What the outlined cell means here, e.g. "Plans are counted at the outlined price." */
  legend?: string; testId?: string;
}) {
  const shown = (groups ?? []).filter((g) => g.rows.length);
  if (!groups) return null;
  if (!shown.length) return <p className="mr-empty" role="status" data-testid={testId}>No engine can be priced right now. Every take is still quoted on its button before it runs.</p>;
  return (
    <div className="mr-card" data-testid={testId}>
      {shown.map((group) => {
        const columns = sortOptions([...new Set(group.rows.flatMap((r) => r.cells.map((c) => c.option)))]);
        /* A shared header reads as a table; past four sizes each cell names its own. */
        const aligned = columns.length <= 4;
        const take = group.kind === "video" ? reference?.video : reference?.image;
        return (
          <section key={group.kind} className="mr-group" data-kind={group.kind} data-aligned={aligned} aria-label={group.kind === "video" ? "Video credits per take" : "Image credits per take"} style={{ ["--mr-cols" as string]: String(aligned ? columns.length : 4) }}>
            <header className="mr-group-head">
              <span className="mr-group-label">
                <span className="mr-group-title"><KindMark kind={group.kind} />{group.kind === "video" ? "Video" : "Images"}</span>
                <span className="mr-group-per">{group.kind === "video" ? `cr per ${group.seconds ?? 5} s` : "cr per image"}</span>
              </span>
              {aligned ? columns.map((c) => <span key={c} className="mr-col" aria-hidden="true">{optionLabel(c)}</span>) : null}
            </header>
            {group.rows.map((row) => (
              <div key={row.engine} className="mr-row" data-testid="rate-row" data-engine={row.engine}>
                <span className="mr-engine">{row.label}</span>
                <span className="mr-cells">
                  {(aligned ? columns.map((option) => row.cells.find((c) => c.option === option) ?? { option, credits: null }) : row.cells).map((cell) => (
                    <span key={cell.option} className="mr-cell" data-empty={cell.credits == null} data-reference={isReference(take, row.engine, cell.option) || undefined}
                      aria-label={cell.credits == null ? `${optionLabel(cell.option)} not offered` : `${optionLabel(cell.option)}: ${grouped(cell.credits)} credits`}>
                      <span className="mr-cell-opt" data-aligned={aligned}>{optionLabel(cell.option)}</span>
                      <span className="mr-cell-cr">{cell.credits == null ? "—" : grouped(cell.credits)}</span>
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </section>
        );
      })}
      {legend && (reference?.video || reference?.image) ? <p className="mr-legend"><span className="mr-legend-key" aria-hidden="true" />{legend}</p> : null}
    </div>
  );
}
