"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import LazyMedia from "@/components/LazyMedia";
import { SoulIdentityPanel } from "@/components/workbench/SoulIdentityPanel";
import { castCards, type CastCard, type CastGroup, type CastTone } from "@/lib/workspace/cast";
import { useDraftEditor } from "@/lib/workspace/draft-editor";
import { mediaBands } from "@/lib/workspace/format";
import { useIdentities } from "@/lib/workspace/identities";
import { usePageAction } from "@/lib/workspace/page-actions";
import { useWorkspace } from "@/lib/workspace/state";
import type { Project } from "@/lib/workbench/studio";
import { soulIdentityAsset } from "@/lib/workbench/soul-identity";
import { Kicker } from "../ui";
import type { PageBodyProps } from "./registry";
import "@/app/workspace-assets.css";

export const TONE: Record<CastTone, string> = {
  green: "var(--pxw-green)", blue: "var(--pxw-blue-ink)", amber: "var(--pxw-amber)", red: "var(--pxw-red)", grey: "var(--pxw-dimmer)",
};

/** The draft, its identities and the cards they make — shared by the page and its Inspector. */
export function useCast(scope: string, shellProject: Project | null) {
  const draft = useDraftEditor(scope, shellProject?.id ?? null);
  const identities = useIdentities(scope, shellProject?.id ?? null);
  const project = draft.project ?? shellProject;
  const data = identities.state.data;
  const cards = useMemo(() => (project ? castCards(project, data) : []), [project, data]);
  return { draft, identities, project, cards, terms: data?.terms ?? null };
}

/** The live training price, as the identity panel's Train button will show it. */
export function trainingQuote(terms: { trainingCredits: number | null; trainingCostUsd?: number | null } | null | undefined): string | null {
  if (typeof terms?.trainingCredits === "number") return `${terms.trainingCredits.toLocaleString("en-US")} cr`;
  if (typeof terms?.trainingCostUsd === "number") return `$${terms.trainingCostUsd.toFixed(2)}`;
  return null;
}

function CastMedia({ card }: { card: CastCard }) {
  if (card.url) return <LazyMedia url={card.url} kind="image" alt="" className="pxw-lazy" />;
  const [top, bottom] = mediaBands(card.id);
  return (
    <span className="pxw-flat" aria-hidden="true">
      <span style={{ background: top }} />
      <span style={{ background: bottom }} />
    </span>
  );
}

const GROUPS: { id: CastGroup; title: string; note: string; add: string }[] = [
  { id: "cast", title: "CAST", note: "identity holds across every shot", add: "+ Add cast" },
  { id: "elements", title: "ELEMENTS", note: "objects, wardrobe and environments", add: "+ Add element" },
];

type Panel = { subjectType: "character" | "element"; assetId?: string };

/** Cast & Elements: identities and references, and the shots that cite them. */
export function CastPage({ project: shellProject, scope }: PageBodyProps) {
  const { state, dispatch, syncUrl, toast } = useWorkspace();
  const router = useRouter();
  const { draft, identities, project, cards, terms } = useCast(scope, shellProject);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const ready = draft.state.status === "ready" && !!draft.project;
  const quote = trainingQuote(terms);

  useEffect(() => {
    if (!project || identities.state.status === "loading" || identities.state.status === "idle") return;
    dispatch({ type: "lists", lists: { cast: cards.map((c) => ({ id: c.id, name: c.name, group: c.group })) } });
  }, [cards, project, identities.state.status, dispatch]);

  /* Header "+ Add cast" and the Inspector's lock button open the identity panel. */
  usePageAction("cast", (assetId) => {
    if (!ready) { setProblem("Open a saved project before adding cast."); return; }
    const card = assetId ? cards.find((c) => c.asset?.id === assetId) : null;
    setPanel({ subjectType: card?.group === "elements" ? "element" : "character", ...(assetId ? { assetId } : {}) });
  });

  useEffect(() => {
    if (!state.selId) return;
    document.querySelector<HTMLElement>(`[data-cast-id="${CSS.escape(state.selId)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [state.selId]);

  const select = (id: string) => {
    dispatch({ type: "patch", patch: { selKind: "cast", selId: id, inspector: true } });
    syncUrl();
  };

  const addElements = async (files: File[]) => {
    if (!files.length) return;
    setProblem(null);
    try {
      const added = await draft.uploadAssets(files, "Element", setProgress);
      if (added.length) toast(`${added.length.toLocaleString("en-US")} ${added.length === 1 ? "element" : "elements"} added, stored byte-identical.`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The element could not be added.");
    } finally {
      setProgress(null);
    }
  };

  const loading = !project || (draft.state.status === "loading" && !draft.project) || identities.state.status === "loading" || identities.state.status === "idle";
  return (
    <div className="pxw-cast" data-page-body="cast">
      <input ref={picker} type="file" accept="image/*" multiple hidden aria-label="Upload element references" onChange={(e) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = "";
        void addElements(files);
      }} />
      {progress ? <p className="pxw-notice" role="status"><span className="pxw-dot pxw-dot--pulse" style={{ background: "var(--pxw-blue)" }} aria-hidden="true" />{progress}</p> : null}
      {problem || draft.state.error || identities.state.error ? (
        <p className="pxw-notice pxw-notice--error" role="alert">{problem ?? draft.state.error ?? identities.state.error}</p>
      ) : null}
      {loading ? (
        <p className="pxw-empty" role="status">{shellProject ? "Loading cast and elements…" : "Open a project to see its cast."}</p>
      ) : (
        GROUPS.map((group) => {
          const items = cards.filter((c) => c.group === group.id);
          return (
            <section className="pxw-cast-group" key={group.id} aria-label={group.title === "CAST" ? "Cast" : "Elements"}>
              <div className="pxw-group-head">
                <Kicker>{group.title}</Kicker>
                <span className="pxw-group-count" data-functional-label="">{items.length.toLocaleString("en-US")}</span>
                <span className="pxw-group-note">{group.note}</span>
              </div>
              <div className="pxw-cast-grid">
                {items.map((card) => (
                  <button type="button" key={card.id} className="pxw-cast-card" data-cast-id={card.id} aria-pressed={state.selKind === "cast" && state.selId === card.id} onClick={() => select(card.id)}>
                    <span className="pxw-cast-media">
                      <CastMedia card={card} />
                      <span className="pxw-cast-badge">{card.badge}</span>
                    </span>
                    <span className="pxw-cast-body">
                      <span className="pxw-cast-name">{card.name}</span>
                      <span className="pxw-cast-sub">{card.sub}</span>
                      <span className="pxw-cast-tag">
                        <span className="pxw-dot" style={{ background: TONE[card.tone] }} aria-hidden="true" />
                        <span>{card.tag}</span>
                      </span>
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  className="pxw-cast-add"
                  disabled={!ready}
                  data-testid={group.id === "cast" ? "add-cast" : "add-element"}
                  onClick={() => (group.id === "cast" ? setPanel({ subjectType: "character" }) : picker.current?.click())}
                >
                  <span>{group.add}</span>
                  <span className="pxw-cast-add-sub">{group.id === "cast" ? (quote ? `Identity training · ${quote}` : "Identity") : "Upload references · free"}</span>
                </button>
              </div>
            </section>
          );
        })
      )}
      {panel && draft.project ? (
        <SoulIdentityPanel
          key={`${draft.project.id}:${panel.subjectType}:${panel.assetId ?? ""}`}
          project={draft.project}
          scope={scope}
          enabled={ready}
          subjectType={panel.subjectType}
          assetId={panel.assetId}
          onClose={() => { setPanel(null); void identities.refresh(); }}
          onSettings={() => router.push("/settings#engines")}
          onSave={draft.ensureSaved}
          onUpload={(files) => draft.uploadAssets(files, panel.subjectType === "character" ? "Character" : "Element")}
          onAttach={async (identity, assetId) => {
            const category = panel.subjectType === "character" ? "Character" : "Element";
            draft.onChange((p) => {
              if (!assetId && p.assets.some((a) => a.soulIdentityId === identity.id && a.category === category)) return p;
              const asset = soulIdentityAsset(p, identity, category, assetId);
              return { ...p, assets: assetId ? p.assets.map((a) => (a.id === assetId ? asset : a)) : [...p.assets, asset] };
            });
            if (!(await draft.ensureSaved())) throw new Error("The identity is attached on screen. Save this project before leaving to retain the binding.");
            toast("Identity attached. Every shot citing it reuses the same reference set.");
          }}
        />
      ) : null}
    </div>
  );
}
