"use client";
import LazyMedia from "@/components/LazyMedia";
import type { Project } from "@/lib/workbench/studio";
import { COMPOSER_TYPES, TYPE_LABELS } from "@/lib/workspace/composer";
import { mediaBands } from "@/lib/workspace/format";
import { useProjectLibrary } from "@/lib/workspace/library";
import { makeDays, makeHeader, makeKindOfType, unfiledTakes, type MakeSource } from "@/lib/workspace/make";
import { useWorkspace } from "@/lib/workspace/state";
import { useNow } from "@/lib/workspace/use-now";
import { MobileRing, RING } from "../MobileRing";
import { useMakeComposer } from "../MakeComposer";

/**
 * Make — the unfiled wall (05-mobile "Make (M4)", the repo's board M4).
 *
 * Video / Images / Audio is the composer's own type, not a second control:
 * the tab picks what the wall shows AND what the composer would make, which
 * is the vocabulary drift CLAUDE.md rule 5 names, closed.
 *
 * "Unfiled" is the repo's own meaning: a generation with no `shotId`. A render
 * from the docked composer is filed to a shot as it always has been (the
 * composer's own flow, CLAUDE.md rule 4 — extend, don't replace), so it opens
 * in Takes rather than landing here; the wall holds what arrived without a
 * shot. The empty state says so rather than leaving a person waiting.
 *
 * Every figure is derived from the open project's library — the same read the
 * Takes page uses (GET /api/workbench/library) — through lib/workspace/make.ts.
 * The header line, the day groups, the spec chip and the cost on a card are
 * all computed; none of them is written down. A take still rendering carries
 * the 36px ring over its well, which is the only loader on the screen.
 */
export function MakeScreen({ project, scope }: { project: Project | null; scope: string }) {
  const ws = useWorkspace();
  const ctx = useMakeComposer();
  const library = useProjectLibrary(scope, project?.id ?? null);
  const now = useNow(60_000);
  /* The composer's type IS the wall's tab; the shell always mounts one, and it
     opens on video, so the fallback only guards a body rendered without it. */
  const type = ctx?.host.state.type ?? "video";
  const kind = makeKindOfType(type);

  const generations = library.state.generations as unknown as MakeSource[];
  const items = unfiledTakes(generations, kind);
  const header = makeHeader(items);
  /* Ages tick, so “12 min” is true a minute later without a reload. */
  const days = makeDays(items, now);

  return (
    <div className="pxm-pad" data-screen="make">
      <div className="pxm-segmented" role="group" aria-label="What to make" data-testid="mobile-make-tabs">
        {COMPOSER_TYPES.map((option) => (
          <button
            key={option}
            type="button"
            className="pxm-segment"
            data-on={type === option ? "" : undefined}
            data-kind={option}
            aria-pressed={type === option}
            onClick={() => ctx?.host.dispatch({ type: "type", value: option })}
          >
            {TYPE_LABELS[option]}
          </button>
        ))}
      </div>

      <div className="pxm-make-head" data-testid="mobile-make-header">
        {header.map((segment, i) => (
          <span key={segment} className="pxm-make-head-part">
            {i ? <span className="pxm-dot4" aria-hidden="true" /> : null}
            <span className="pxm-make-head-text" data-functional-label="">{segment}</span>
          </span>
        ))}
      </div>

      {library.state.error ? <p className="pxm-problem" role="alert">{library.state.error}</p> : null}

      {days.length ? (
        days.map((day) => (
          <section className="pxm-make-day" key={day.key} data-day={day.key}>
            <div className="pxm-make-day-head">
              <span className="pxm-kicker" data-functional-label="">{day.day}</span>
              <span className="pxm-make-day-count">{day.count}</span>
            </div>
            <div className="pxm-make-grid">
              {day.items.map((card) => {
                const [c1, c2] = mediaBands(card.id);
                return (
                  <button
                    type="button"
                    className="pxm-take"
                    key={card.id}
                    data-take={card.id}
                    data-testid="mobile-take-card"
                    onClick={() => {
                      /* The Inspector selects by the library's own id, which is
                         what lib/genLibrary libraryId writes for a generation. */
                      ws.dispatch({ type: "patch", patch: { selKind: "take", selId: `generation:${card.id}` } });
                      ws.setSheet("inspector");
                    }}
                  >
                    <span className="pxm-take-well">
                      {card.url && (card.kind === "image" || card.kind === "video") ? (
                        <LazyMedia url={card.url} kind={card.kind} alt="" className="pxm-take-media" />
                      ) : (
                        <>
                          <span className="pxm-band-a" style={{ background: c1 }} />
                          <span className="pxm-band-b" style={{ background: c2 }} />
                        </>
                      )}
                      {card.rendering ? (
                        <span className="pxm-take-loading" data-testid="mobile-take-ring">
                          <MobileRing size={RING.well} beating label="Rendering" />
                        </span>
                      ) : null}
                    </span>
                    <span className="pxm-take-body">
                      <span className="pxm-take-spec" data-functional-label="">{card.spec}</span>
                      <span className="pxm-take-prompt">{card.prompt || card.name}</span>
                      <span className="pxm-take-foot">
                        <span className="pxm-take-by">{card.by}</span>
                        {card.cost ? <span className="pxm-take-cost" data-failed={card.failed ? "" : undefined}>{card.cost}</span> : null}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))
      ) : (
        <p className="pxm-note" data-testid="mobile-make-empty">
          {project
            ? `Nothing unfiled in ${TYPE_LABELS[type].toLowerCase()} yet. A render from the composer is filed to its own shot and opens in Takes; what arrives without a shot waits here.`
            : "Open a project to see its unfiled takes. Generating without one starts a project called “Untitled”."}
        </p>
      )}
    </div>
  );
}
