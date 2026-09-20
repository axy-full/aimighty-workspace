"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { castCards, type CastCard, type CastGroup } from "@/lib/workspace/cast";
import { useDraftEditor } from "@/lib/workspace/draft-editor";
import { mediaBands } from "@/lib/workspace/format";
import { useIdentities } from "@/lib/workspace/identities";
import { useProjectLibrary, type LibraryEntry } from "@/lib/workspace/library";
import { usePublishPrimary } from "@/lib/workspace/mobile-primary";
import { useWorkspace } from "@/lib/workspace/state";
import { matchesFilter, takeCost, takeStatus, versionLabel } from "../../pages/TakesPage";
import { TONE } from "../../pages/CastPage";
import type { MobilePageProps } from "../screens/registry";
import "@/app/workspace-assets.css";

/**
 * Cards (05-mobile, template 3): 2-up cards with media, a badge, the name and a
 * dot + tag line. Two pages use it, and each reads exactly what its desktop
 * page reads — Cast & Elements the draft's own assets and identities through
 * `castCards`, Takes the real project library through `useProjectLibrary`, with
 * `takeStatus`, `takeCost` and `versionLabel` imported from the desktop page so
 * a phone can never label or price a take differently.
 *
 * Neither page duplicates a paid path. Adding references uploads your own
 * originals, which is free; identity training and generation keep their own
 * priced approvals where they already live.
 */

const GROUPS: { id: CastGroup; title: string; note: string; add: string; category: string }[] = [
  { id: "cast", title: "CAST", note: "identity holds across every shot", add: "+ Add cast", category: "Character" },
  { id: "elements", title: "ELEMENTS", note: "objects, wardrobe and environments", add: "+ Add element", category: "Element" },
];

function Flat({ id }: { id: string }) {
  const [top, bottom] = mediaBands(id);
  return (
    <span className="pxm-flat" aria-hidden="true">
      <span className="pxm-card-band-a" style={{ background: top }} />
      <span className="pxm-card-band-b" style={{ background: bottom }} />
    </span>
  );
}

/* ── Cast & Elements ─────────────────────────────────────────────────────── */

export function CastCardsPage({ project: shellProject, scope }: MobilePageProps) {
  const ws = useWorkspace();
  const { state, dispatch } = ws;
  const draft = useDraftEditor(scope, shellProject?.id ?? null);
  const identities = useIdentities(scope, shellProject?.id ?? null);
  const project = draft.project ?? shellProject;
  const cards = useMemo(() => (project ? castCards(project, identities.state.data) : []), [project, identities.state.data]);
  const picker = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState("Character");
  const [progress, setProgress] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const ready = draft.state.status === "ready" && !!draft.project;

  /* The selection repair, the Inspector sheet and the page's sub read this list. */
  useEffect(() => {
    if (!project || identities.state.status === "loading" || identities.state.status === "idle") return;
    dispatch({ type: "lists", lists: { cast: cards.map((card) => ({ id: card.id, name: card.name, group: card.group })) } });
  }, [cards, project, identities.state.status, dispatch]);

  const pick = (next: string) => {
    if (!ready) {
      setProblem("Open a saved project before adding references.");
      return;
    }
    setCategory(next);
    picker.current?.click();
  };

  usePublishPrimary(
    "cast",
    useMemo(
      () => ({
        label: "+ Add cast",
        cost: null,
        blocked: ready ? null : "Open a saved project before adding references.",
        run: () => pick("Character"),
      }),
      // `pick` is stable for a given readiness; the picker ref is not state.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [ready],
    ),
  );

  const add = async (files: File[]) => {
    if (!files.length) return;
    setProblem(null);
    try {
      const added = await draft.uploadAssets(files, category, setProgress);
      if (added.length) ws.toast(`${added.length.toLocaleString("en-US")} ${added.length === 1 ? "original" : "originals"} added, stored byte-identical.`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The reference could not be added.");
    } finally {
      setProgress(null);
    }
  };

  const loading = !project || (draft.state.status === "loading" && !draft.project) || identities.state.status === "loading" || identities.state.status === "idle";
  return (
    <div className="pxm-pad-x pxm-pad-top" data-template="cards" data-testid="mobile-cards">
      <input
        ref={picker}
        type="file"
        accept="image/*"
        multiple
        hidden
        aria-label="Upload references"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void add(files);
        }}
      />
      {progress ? <p className="pxm-note" role="status">{progress}</p> : null}
      {problem || draft.state.error || identities.state.error ? (
        <p className="pxm-note" role="alert">{problem ?? draft.state.error ?? identities.state.error}</p>
      ) : null}
      {loading ? (
        <p className="pxm-empty" role="status">{shellProject ? "Loading cast and elements…" : "Open a project to see its cast."}</p>
      ) : (
        GROUPS.map((group) => {
          const items = cards.filter((card) => card.group === group.id);
          return (
            <section className="pxm-group" key={group.id} aria-label={group.title === "CAST" ? "Cast" : "Elements"}>
              <div className="pxm-group-head">
                <span className="pxm-kicker" data-functional-label="">{group.title}</span>
                <span className="pxm-group-note">{group.note}</span>
              </div>
              <div className="pxm-grid2">
                {items.map((card) => (
                  <CastTile key={card.id} card={card} selected={state.selKind === "cast" && state.selId === card.id} onOpen={() => {
                    dispatch({ type: "patch", patch: { selKind: "cast", selId: card.id, inspector: true } });
                    ws.syncUrl();
                    ws.setSheet("inspector");
                  }} />
                ))}
                <button type="button" className="pxm-tile-add" data-testid={group.id === "cast" ? "mobile-add-cast" : "mobile-add-element"} onClick={() => pick(group.category)}>
                  <span>{group.add}</span>
                  <span className="pxm-tile-add-sub">Your own references · free</span>
                </button>
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

function CastTile({ card, selected, onOpen }: { card: CastCard; selected: boolean; onOpen: () => void }) {
  return (
    <button type="button" className="pxm-tile" data-cast-id={card.id} aria-pressed={selected} onClick={onOpen}>
      <span className="pxm-tile-media" data-ratio="4/3">
        {card.url ? <LazyMedia url={card.url} kind="image" alt="" className="pxw-lazy" /> : <Flat id={card.id} />}
        <span className="pxm-tile-badge" data-functional-label="">{card.badge}</span>
      </span>
      <span className="pxm-tile-body">
        <span className="pxm-tile-name">{card.name}</span>
        <span className="pxm-row pxm-tile-tag">
          <span className="pxm-dot5" style={{ background: TONE[card.tone] }} aria-hidden="true" />
          <span className="pxm-tile-tag-label">{card.tag}</span>
        </span>
      </span>
    </button>
  );
}

/* ── Takes ───────────────────────────────────────────────────────────────── */

export function TakesCardsPage({ project, scope }: MobilePageProps) {
  const ws = useWorkspace();
  const { state, dispatch } = ws;
  const library = useProjectLibrary(scope, project?.id ?? null);
  const { items } = library;
  const picker = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (library.state.status !== "ready") return;
    dispatch({
      type: "lists",
      lists: { takes: items.map(({ take }) => ({ id: take.id, name: take.name, kind: take.kind === "UPLOAD" ? "upload" : "generation", credits: take.credits })) },
    });
  }, [items, library.state.status, dispatch]);

  usePublishPrimary(
    "takes",
    useMemo(
      () => ({
        label: "+ Upload",
        cost: null,
        blocked: project ? null : "Open a saved project before uploading.",
        run: () => picker.current?.click(),
      }),
      [project],
    ),
  );

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setProblem(null);
    try {
      const count = await library.upload(files);
      if (count) ws.toast(`${count.toLocaleString("en-US")} ${count === 1 ? "original" : "originals"} added, stored byte-identical.`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The upload could not be completed.");
    }
  };

  const visible = items.filter((entry) => matchesFilter(entry.take, state.libFilter));
  const { status, error, uploading, next, moreBusy } = library.state;
  const more = Boolean(next.uploads || next.generations);
  return (
    <div className="pxm-pad-x pxm-pad-top" data-template="cards" data-testid="mobile-cards">
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        aria-label="Upload originals to this project"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void upload(files);
        }}
      />
      {uploading ? <p className="pxm-note" role="status">{uploading} · originals are stored byte-identical</p> : null}
      {problem || (error && status === "ready") ? <p className="pxm-note" role="alert">{problem ?? error}</p> : null}
      {status === "error" ? (
        <p className="pxm-empty" role="alert">{error}</p>
      ) : status !== "ready" ? (
        <p className="pxm-empty" role="status">{project ? "Loading the project library…" : "Open a project to see its library."}</p>
      ) : !items.length ? (
        <p className="pxm-empty">No uploads or generations in this project yet. Upload adds your originals, stored byte-identical.</p>
      ) : !visible.length ? (
        <p className="pxm-empty">{state.libFilter === "Uploads" ? "No uploads in this project yet." : "No generations in this project yet."}</p>
      ) : (
        <div className="pxm-grid2" data-testid="mobile-take-grid">
          {visible.map((entry) => (
            <TakeTile
              key={entry.take.id}
              entry={entry}
              selected={state.selKind === "take" && state.selId === entry.take.id}
              onOpen={() => {
                dispatch({ type: "patch", patch: { selKind: "take", selId: entry.take.id, inspector: true } });
                ws.syncUrl();
                ws.setSheet("inspector");
              }}
            />
          ))}
        </div>
      )}
      {status === "ready" && more ? (
        <button type="button" className="pxm-dashed" disabled={moreBusy} onClick={() => void library.more()}>
          {moreBusy ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}

function TakeTile({ entry, selected, onOpen }: { entry: LibraryEntry; selected: boolean; onOpen: () => void }) {
  const { take } = entry;
  const s = takeStatus(take);
  return (
    <button
      type="button"
      className="pxm-tile"
      data-take-id={take.id}
      data-kind={take.kind}
      aria-pressed={selected}
      aria-label={`${take.name}, ${take.version}, ${take.kind === "GEN" ? "generation" : "upload"}`}
      onClick={onOpen}
    >
      <span className="pxm-tile-media" data-ratio="16/9">
        {entry.url && (entry.media === "image" || entry.media === "video") ? (
          <LazyMedia url={entry.url} kind={entry.media} alt="" className="pxw-lazy" />
        ) : (
          <Flat id={take.id} />
        )}
        <span className="pxm-tile-version" data-functional-label="">{versionLabel(take)}</span>
        <span className="pxm-tile-kind" data-kind={take.kind} data-functional-label="">{take.kind}</span>
      </span>
      <span className="pxm-tile-body">
        <span className="pxm-tile-name">{take.name}</span>
        <span className="pxm-tile-meta">
          <span>{take.meta}</span>
          <span data-testid="mobile-take-cost">{takeCost(take)}</span>
        </span>
        <span className="pxm-row pxm-tile-tag">
          <span className="pxm-dot5" style={{ background: s.dot }} aria-hidden="true" />
          <span className="pxm-tile-tag-label">{s.label}</span>
        </span>
      </span>
    </button>
  );
}
