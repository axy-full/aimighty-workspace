"use client";
import { useMemo, useState } from "react";
import { useMake, type MakeModel } from "../make/use-make";
import { MakePriceText } from "../make/Compose";
import { usePriceTitle } from "../Price";
import type { ComposerType } from "@/lib/workspace/composer";
import type { LibraryEntry } from "@/lib/workspace/library";
import type { Project } from "@/lib/workbench/studio";
import { Eyebrow } from "./PhoneChrome";
import { NEEDS_CONNECTION } from "./HomeScreen";
import { PhoneSheet } from "./PhoneSheet";
import { readableTakeName } from "./phone-model";

const TYPES: { type: ComposerType; label: string }[] = [{ type: "video", label: "Video" }, { type: "image", label: "Image" }, { type: "audio", label: "Audio" }];
const SAY_WHAT = "Say what to make.";

/**
 * Make on the phone (design/particl-graphite/README.md § 3.6, frame F): the words in a 17 px box with the type under
 * them, the engine as one line with Change, the references with Add, where the result lands, and Make at its
 * price, pinned. It is stream 6's Make logic (components/graphite/make/use-make.ts) on today's composer,
 * unchanged: the live quote, the one send at the price on the button, and the held take when credits are short
 * (the line above the button says so, and Make stays pressable). Atomik's "make …" fills the box; a person
 * presses Make. Nothing here has a price of its own.
 *
 * Change opens this type's engines, each priced where the composer stands. Add opens the project's pictures and
 * videos; picking one makes it a reference. Offline, Make says "Needs a connection".
 */
export function MakeScreen({ scope, project, items, workspaceName, balance, projects, onProject, online, onTopUp }: {
  scope: string;
  project: Project | null;
  items: readonly LibraryEntry[];
  workspaceName: string | null;
  balance: number | null;
  projects: "loading" | "ready" | "error";
  onProject: (id: string) => void;
  online: boolean;
  onTopUp: () => void;
}) {
  const make = useMake({ scope, project, projects, workspaceName, onProject, balance, onBoard: true });
  const [adding, setAdding] = useState(false);
  const [said, setSaid] = useState(false);
  const goTitle = usePriceTitle(make.go.price?.value ?? null);
  const { state } = make;
  const waits = Boolean(make.go.blocked) || !online;
  const reason = !online ? NEEDS_CONNECTION : make.go.blocked && (make.go.blocked !== SAY_WHAT || said) ? make.go.blocked : null;
  const press = () => {
    if (!online) return;
    if (make.go.blocked) { setSaid(true); return; }
    setSaid(false);
    make.go.press();
  };
  return (
    <>
      <main className="ph-scroll" data-testid="mobile-scroll">
        <div className="ph-make" data-testid="phone-make">
          <textarea className="ph-make-text" aria-label="What to make" rows={4} placeholder="make shot 2 at golden hour" value={state.prompt}
            onChange={(e) => make.setPrompt(e.target.value)} data-testid="phone-make-prompt" />
          <div className="ph-seg" role="radiogroup" aria-label="Type">
            {TYPES.map(({ type, label }) => (
              <button key={type} type="button" role="radio" className="ph-seg-btn" aria-checked={state.type === type} onClick={() => make.pickType(type)} data-testid={`phone-make-type-${type}`}>{label}</button>
            ))}
          </div>
          {make.typeNote ? <p className="ph-row-line">{make.typeNote}</p> : null}

          <section className="ph-section" aria-label="Engine">
            <Eyebrow>Engine</Eyebrow>
            <div className="ph-row" data-testid="phone-make-engine">
              <span className="ph-row-text">
                <span className="ph-row-title ph-make-line" data-testid="phone-make-engine-line">
                  {make.line.length ? make.line.join(" · ") : make.readingModels ? "Reading the engines…" : "Choose an engine"}
                  {make.linePrice ? <> · <MakePriceText price={make.linePrice} /></> : null}
                </span>
              </span>
              <button type="button" className="ph-btn" onClick={make.openList} data-testid="phone-make-change">Change</button>
            </div>
          </section>

          {make.takesReferences ? (
            <section className="ph-section" aria-label="References">
              <Eyebrow aside={make.references.length ? String(make.references.length) : null}>References</Eyebrow>
              <div className="ph-make-refs">
                {make.references.map((r, i) => (
                  <span key={r.key} className="ph-make-ref" title={`${make.tags[i]} · ${r.name}`} data-testid="phone-make-reference">
                    {r.kind === "image" ? <img src={r.url} alt="" /> : <span className="ph-make-ref-kind" aria-hidden="true">{r.kind === "video" ? "▶" : "♪"}</span>}
                    <span className="ph-make-ref-name">{r.name}</span>
                    <button type="button" className="ph-make-ref-x" aria-label={`Remove ${r.name}`} onClick={() => make.removeReference(r.key)}>×</button>
                  </span>
                ))}
                <button type="button" className="ph-btn" onClick={() => setAdding(true)} data-testid="phone-make-add">Add</button>
              </div>
              {make.wellError ? <p className="ph-row-line ph-row-line--warn" role="alert">{make.wellError}</p> : null}
            </section>
          ) : null}

          <p className="ph-row-line" data-testid="phone-make-dest">{`Lands in ${make.composer.project?.name?.trim() || "a new project"} · Library, and on the board.`}</p>
          {make.notices.map((n) => <p key={n} className="ph-row-line" role="status">{n}</p>)}
        </div>
      </main>
      <div className="ph-pinned" data-testid="mobile-actions">
        {make.short ? (
          <div className="ph-plan-short" role="status" data-testid="phone-make-short">
            <span className="ph-plan-short-text"><strong>{make.short}</strong> · the take waits until credits arrive</span>
            <button type="button" className="ph-btn ph-btn--hot" onClick={onTopUp} data-testid="phone-make-topup">Top up</button>
          </div>
        ) : null}
        <button type="button" className="ph-btn ph-btn--primary" aria-disabled={waits || undefined} title={(waits ? reason : goTitle) ?? undefined}
          data-waits={waits ? "" : undefined} data-spend={online && make.go.price ? "priced" : "unpriced"} onClick={press} data-testid="phone-make-go">
          {!online ? NEEDS_CONNECTION : <>
            <span>{make.go.action}</span>
            {make.go.price ? <><span> · </span><MakePriceText price={make.go.price} /></> : null}
          </>}
        </button>
        {reason && online ? <p className="ph-row-line ph-plan-why" role="status" data-testid="phone-make-blocked">{reason}</p> : null}
      </div>
      {make.listOpen ? <EngineSheet make={make} /> : null}
      {adding ? <ReferenceSheet items={items} taken={make.references.map((r) => r.id)} onPick={(id) => { void make.addReference(id); setAdding(false); }} onClose={() => setAdding(false)} /> : null}
    </>
  );
}

/** Change: this type's engines, each priced where the composer stands; the one in use is marked. */
function EngineSheet({ make }: { make: MakeModel }) {
  const { state, model, settings, composer } = make;
  const lengths = model?.durations ?? [];
  return (
    <PhoneSheet title="Engine" onClose={make.closeList} testId="phone-make-engines">
      {make.offered.length ? (
        <div role="group" aria-label={`${state.type} engines`} className="ph-make-engines">
          {make.offered.map((m) => {
            const row = make.rowValue(m);
            return (
              <button key={m.id} type="button" className="ph-make-engine-row" aria-pressed={m.id === model?.id} onClick={() => make.pickEngine(m)} data-testid="phone-make-engine-row">
                <span className="ph-row-text">
                  <span className="ph-row-title">{m.label}</span>
                  {m.description ? <span className="ph-row-line">{m.description}</span> : null}
                </span>
                <span className="ph-row-line" title={row.value ? undefined : row.title} data-testid="phone-make-engine-row-price"><MakePriceText price={row} />{row.detail ? ` · ${row.detail}` : null}</span>
              </button>
            );
          })}
        </div>
      ) : <p className="ph-quiet" role="status">{make.readingModels ? "Reading the engines…" : composer.blocked ?? "No engine is connected for this type."}</p>}
      {state.type === "video" && lengths.length > 1 ? (
        <div className="ph-seg ph-make-lengths" role="group" aria-label="Length">
          {lengths.filter((d) => [4, 5, 6, 8, 10].includes(d) || d === settings.duration).map((d) => (
            <button key={d} type="button" className="ph-seg-btn" aria-pressed={settings.duration === d} onClick={() => composer.dispatch({ type: "pick", value: { duration: d } })}>{d} s</button>
          ))}
        </div>
      ) : null}
    </PhoneSheet>
  );
}

/** Add: the project's pictures and videos, newest first; picking one makes it a reference. */
function ReferenceSheet({ items, taken, onPick, onClose }: { items: readonly LibraryEntry[]; taken: readonly string[]; onPick: (id: string) => void; onClose: () => void }) {
  const list = useMemo(() => items.filter((e) => e.url && (e.media === "image" || e.media === "video") && !taken.includes(e.take.id)).slice(0, 60), [items, taken]);
  return (
    <PhoneSheet title="Add a reference" onClose={onClose} testId="phone-make-refs-sheet">
      {list.length ? (
        <div className="ph-make-pick">
          {list.map((e) => (
            <button key={e.take.id} type="button" className="ph-make-pick-tile" onClick={() => onPick(e.take.id)} data-testid="phone-make-pick">
              {e.media === "image" ? <img src={e.url!} alt="" loading="lazy" /> : <video src={e.url!} muted playsInline preload="metadata" />}
              <span className="ph-make-ref-name">{readableTakeName(e.take.name)}</span>
            </button>
          ))}
        </div>
      ) : <p className="ph-quiet" role="status" data-testid="phone-make-nopics">Nothing in this project’s Library to use yet.</p>}
    </PhoneSheet>
  );
}

