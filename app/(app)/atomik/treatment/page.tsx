"use client";

/**
 * Atomik · Treatment — from the pipeline handoff.
 *
 * One document per production: the logline, the setup defaults that will
 * be carried into every Particl shot, and the scenes — each with a length,
 * because scene lengths are what the breakdown will have to fit. Every
 * @name in the prose is a cast entry waiting to be given a still.
 *
 * Three columns: the outline (scenes, runtime, the way to the breakdown),
 * the document, and the rail (cast found, notes in the margin). Autosaves
 * as you type; "Save draft" starts a new draft number.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useProject } from "@/lib/projectContext";
import { useSession } from "@/lib/session";
import { writerCall } from "@/lib/rateTable";
import { usePageTitle } from "@/lib/usePageTitle";
import { timeAgo } from "@/lib/format";
import { CATEGORIES } from "@/lib/studio";
import { mentionsIn } from "@/lib/mentions";
import { appAlert, appConfirm } from "@/components/dialog";
import { Waiting } from "@/components/ParticlMark";
import { useDraft } from "@/lib/useDraft";
import MentionText from "@/components/atomik/MentionText";
import PickProduction from "@/components/atomik/PickProduction";
import type { Treatment, Scene, Note } from "@/lib/atomikDocs";
import type { CastMember } from "@/lib/cast";
import type { Shot } from "@/lib/shots";
import { useMoney } from "@/lib/price";
import { textModelFor } from "@/lib/platformLayer";

type Loaded = { versions?: { version: number; by: string; at: number }[]; snapshot?: { draft: number; title: string; logline: string; setup: Record<string, string>; scenes: Scene[]; notes: Note[]; updatedBy: string; at: number } | null; treatment: Treatment | null; cast: CastMember[]; identities: { name: string; status: string }[] };
type Doc = { title: string; logline: string; setup: Record<string, string>; scenes: Scene[]; notes: Note[] };
/** A shot's scene as a number: "SC01", "1" and "Scene 1" all mean scene 1. */
const sceneNo = (scene: string) => Number((scene ?? "").replace(/\D/g, "")) || 0;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "—";
/* The setup defaults a treatment carries: the four the reference shows. */
const SETUP_KEYS = ["mood", "light", "look", "lens"];

export default function TreatmentPage() {
  usePageTitle("Atomik · Treatment");
  const { selection, current } = useProject();
  const scoped = selection !== "all" && selection !== "unfiled";
  if (!scoped) return <div className="ak-page"><PickProduction stage="Treatment" /></div>;
  return <Editor key={selection} projectId={selection} name={current?.name ?? "Production"} runtimeTarget={current?.runtimeTarget ?? null} />;
}

function Editor({ projectId, name, runtimeTarget }: { projectId: string; name: string; runtimeTarget: number | null }) {
  const router = useRouter();
  const { signedIn, name: me , models: sessionModels, rates } = useSession();
  const { data, refresh } = useApi<Loaded>(signedIn ? `/api/atomik/treatment?projectId=${encodeURIComponent(projectId)}` : null, 0);
  const { data: shotData } = useApi<{ shots: Shot[] }>(signedIn ? `/api/shots?projectId=${encodeURIComponent(projectId)}` : null, 30_000);
  const [doc, setDoc] = useState<Doc | null>(null);
  const money = useMoney();
  const [tab, setTab] = useState<"cast" | "notes">("cast");
  const [active, setActive] = useState(1);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const dirty = useRef(false);

  // The document is the server's until someone types; then it is theirs.
  useEffect(() => {
    if (!data || doc) return;
    const t = data.treatment;
    Promise.resolve().then(() => setDoc(t
      ? { title: t.title, logline: t.logline, setup: t.setup, scenes: t.scenes.length ? t.scenes : [{ n: 1, title: "", secs: 5, prose: "" }], notes: t.notes }
      : { title: name, logline: "", setup: {}, scenes: [{ n: 1, title: "", secs: 5, prose: "" }], notes: [] }));
  }, [data, doc, name]);

  async function save(bump = false) {
    if (!doc) return;
    setSaving(true);
    try {
      const res = await fetch("/api/atomik/treatment", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, ...doc, bump }),
      });
      if (!res.ok) throw new Error(`The server answered ${res.status}.`);
      dirty.current = false;
      setSavedAt(Date.now());
      if (bump) refresh();
    } catch (e) { await appAlert("Not saved", (e as Error).message); }
    finally { setSaving(false); }
  }
  // Autosave, 900ms after the last keystroke.
  useEffect(() => {
    if (!doc || !dirty.current) return;
    const t = setTimeout(() => save(false), 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);
  // Leaving mid-sentence used to cancel that timer and lose the sentence.
  // The unmount now flushes instead: whatever is unsaved goes out with the
  // page, on a request that outlives it.
  const docRef = useRef<Doc | null>(null);
  useEffect(() => { docRef.current = doc; }, [doc]);
  useEffect(() => () => {
    if (!dirty.current || !docRef.current) return;
    void fetch("/api/atomik/treatment", {
      method: "PUT", headers: { "Content-Type": "application/json" }, keepalive: true,
      body: JSON.stringify({ projectId, ...docRef.current, bump: false }),
    }).catch(() => { /* the next visit re-reads the server's copy */ });
  }, [projectId]);
  const edit = (fn: (d: Doc) => Doc) => { dirty.current = true; setDoc((d) => (d ? fn(d) : d)); };

  /* Regenerate one scene: a proposal, priced before pressing, shown beside the scene; "Use this" is the only way it lands (brief 1.8). */
  const [regen, setRegen] = useState<number | null>(null);
  const [proposal, setProposal] = useState<{ n: number; scene: Scene; model: string; credits: string } | null>(null);
  const regenCr = writerCall(rates, textModelFor(sessionModels ?? null, "idea"), 900, 500) ?? 0.1;
  async function regenerate(idx: number) {
    if (!doc) return;
    const s = doc.scenes[idx];
    await save(false);
    setRegen(s.n); setProposal(null);
    try {
      const res = await fetch("/api/atomik/treatment/scene", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, n: s.n }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `The server answered ${res.status}.`);
      setProposal({ n: s.n, scene: j.scene as Scene, model: String(j.model), credits: money.price(Number(j.costUsd ?? 0), "text") });
    } catch (e) { await appAlert("Not rewritten", (e as Error).message); }
    finally { setRegen(null); }
  }
  async function acceptProposal(idx: number) {
    if (!doc || !proposal) return;
    const cur = doc.scenes[idx];
    if (cur.by === "you" && cur.prose.trim() && !(await appConfirm("Replace your words?", "This scene was written by you. The proposal replaces it; Save draft keeps the old one as a version.", { confirmLabel: "Replace" }))) return;
    edit((d) => ({ ...d, scenes: d.scenes.map((x, i) => (i === idx ? { ...x, title: proposal.scene.title || x.title, secs: proposal.scene.secs || x.secs, prose: proposal.scene.prose, by: proposal.model, at: Date.now() } : x)) }));
    setProposal(null);
  }
  /* Earlier drafts: pick one to read it; restore it as the next draft. */
  const [viewing, setViewing] = useState<number | null>(null);
  const { data: snap } = useApi<Loaded>(signedIn && viewing ? `/api/atomik/treatment?projectId=${encodeURIComponent(projectId)}&version=${viewing}` : null, 0);
  async function restore() {
    const v = snap?.snapshot; if (!v) return;
    edit((d) => ({ ...d, title: v.title, logline: v.logline, setup: v.setup, scenes: v.scenes, notes: v.notes }));
    setViewing(null);
    await save(true);
  }

  const castNames = useMemo(() => (data?.cast ?? []).map((c) => c.name), [data]);
  const mentions = useMemo(() => {
    const count = new Map<string, number>();
    for (const s of doc?.scenes ?? []) for (const n of mentionsIn(s.prose, castNames)) count.set(n, (count.get(n) ?? 0) + (s.prose.toLowerCase().split(`@${n.toLowerCase()}`).length - 1));
    return [...count.entries()];
  }, [doc, castNames]);
  const total = (doc?.scenes ?? []).reduce((a, s) => a + s.secs, 0);
  const target = runtimeTarget ?? total;
  /* Planned seconds per scene, from the breakdown's shots, to see which
     scene is over its length. */
  const plannedFor = (n: number) => (shotData?.shots ?? []).filter((s) => sceneNo(s.scene) === n && s.kind !== "type").reduce((a, s) => a + (s.planned ?? 0), 0);
  const over = (doc?.scenes ?? []).filter((s) => plannedFor(s.n) > s.secs);

  async function addToCast(n: string) {
    const res = await fetch("/api/cast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n, kind: "character", description: "", projectId }) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); await appAlert("Not cast", j.error ?? `The server answered ${res.status}.`); return; }
    refresh();
  }
  function castState(n: string): { word: string; cls: string } {
    const m = (data?.cast ?? []).find((c) => c.name.toLowerCase() === n.toLowerCase());
    const id = (data?.identities ?? []).find((i) => i.name.toLowerCase() === n.toLowerCase());
    if (id?.status === "training") return { word: "TRAINING", cls: "is-ink" };
    if (!m) return { word: "NOT CAST", cls: "is-muted" };
    if (!m.uploadId) return { word: "NEEDS STILL", cls: "is-ink" };
    return { word: "READY", cls: "is-approved" };
  }
  const kindWord = (n: string) => {
    const m = (data?.cast ?? []).find((c) => c.name.toLowerCase() === n.toLowerCase());
    const k = m?.kind === "style" ? "Look" : m ? m.kind[0].toUpperCase() + m.kind.slice(1) : "Character";
    const id = (data?.identities ?? []).find((i) => i.name.toLowerCase() === n.toLowerCase());
    return `${k}${k === "Character" && id ? " · face" : ""}`;
  };

  if (!signedIn) return <div className="ak-page"><PickProduction stage="Treatment" /></div>;
  if (!doc) return <Waiting label="Opening the treatment" />;
  const t = data?.treatment;

  return (
    <div className="ak-trt">
      <aside className="ak-trt-outline">
        <div className="flex flex-col gap-1">
          <span className="mono !tracking-[.14em] !text-[10px]">TREATMENT · DRAFT {t?.draft ?? 1}</span>
          {(data?.versions?.length ?? 0) > 0 && (
            <label className="chip-dd !py-1 self-start"><select value={viewing ?? ""} aria-label="Earlier drafts" onChange={(e) => setViewing(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Earlier drafts</option>
              {data!.versions!.map((v) => <option key={v.version} value={v.version}>Draft {v.version} · {v.by ? initials(v.by) : "—"}</option>)}
            </select><span className="hdr-caret" aria-hidden="true">▼</span></label>
          )}
          {viewing && snap?.snapshot && (
            <div className="ak-snapshot">
              <span className="mono-s">DRAFT {snap.snapshot.draft} · READ-ONLY</span>
              <span className="text-[13px] font-medium">{snap.snapshot.title || "Untitled"}</span>
              <span className="ak-sub !text-[12px]">{snap.snapshot.scenes.length} scene{snap.snapshot.scenes.length === 1 ? "" : "s"} · {snap.snapshot.logline.slice(0, 120)}</span>
              <div className="flex gap-2"><button type="button" className="chip" onClick={restore}>Restore as draft {(t?.draft ?? 1) + 1}</button><button type="button" className="chip" onClick={() => setViewing(null)}>Close</button></div>
            </div>
          )}
          <span className="text-[15px] font-semibold leading-[1.2]">{doc.title || name}</span>
          <span className="ak-sub !text-[12px]">{mmss(total)} · {doc.scenes.length} scene{doc.scenes.length === 1 ? "" : "s"} · {t?.updatedBy ? initials(t.updatedBy) : me ? initials(me) : "—"} · {saving ? "saving…" : savedAt ? `saved ${timeAgo(savedAt)}` : t ? `edited ${timeAgo(t.updatedAt)}` : "unsaved"}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          {doc.scenes.map((s) => (
            <a key={s.n} href={`#scene-${s.n}`} onClick={() => setActive(s.n)} className={`ak-scene-link ${active === s.n ? "is-on" : ""}`}>
              <span className="mono-s">{s.n}</span><span>{s.title || "Untitled"}</span><span className="mono-s">{mmss(s.secs)}</span>
            </a>
          ))}
        </div>
        <div className="ak-runtime">
          <div className="flex justify-between"><span className="mono-s">RUNTIME</span><span className="mono-v">{mmss(total)} / {mmss(target)}</span></div>
          <div className="cv-bar !h-1.5">{doc.scenes.map((s) => <span key={s.n} className={plannedFor(s.n) > s.secs ? "is-over" : "is-picked"} style={{ flex: Math.max(1, s.secs) }} />)}</div>
          <span className="ak-sub !text-[11.5px]">Scene lengths are what the breakdown will have to fit.{over.length ? ` Scene ${over.map((s) => s.n).join(", ")} ${over.length === 1 ? "is" : "are"} over.` : ""}</span>
        </div>
        <div className="mt-auto flex flex-col gap-2 ak-cta is-doc">
          <button type="button" className="btn-secondary justify-center" onClick={() => save(true)} disabled={saving}>Save draft {(t?.draft ?? 1) + 1}</button>
          <button type="button" className="btn-primary justify-center" onClick={() => { save(false); router.push("/atomik/breakdown"); }}>Break down into shots →</button>
        </div>
      </aside>

      <section className="ak-trt-doc">
        <article className="ak-doc">
          <div className="flex flex-col gap-3">
            <input className="ak-doc-h1" value={doc.title} onChange={(e) => edit((d) => ({ ...d, title: e.target.value }))} placeholder={name} aria-label="Title" />
            <textarea className="ak-doc-logline" rows={2} value={doc.logline} onChange={(e) => edit((d) => ({ ...d, logline: e.target.value }))} placeholder="The logline — one or two sentences." aria-label="Logline" />
            <div className="flex flex-wrap gap-1.5">
              {SETUP_KEYS.map((k) => {
                const cat = CATEGORIES.find((c) => c.key === k)!;
                return (
                  <label key={k} className="ak-tag is-line !py-[3px]">
                    <select value={doc.setup[k] ?? ""} onChange={(e) => edit((d) => ({ ...d, setup: { ...d.setup, [k]: e.target.value } }))} aria-label={cat.label} className="ak-tag-select">
                      <option value="">{cat.label}…</option>
                      {cat.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                );
              })}
              <span className="ak-tag is-line is-muted">Setup defaults → carried into every Particl shot</span>
            </div>
          </div>
          {doc.scenes.map((s, idx) => (
            <div key={s.n} id={`scene-${s.n}`} className="ak-scene" onFocus={() => setActive(s.n)}>
              <div className="flex items-baseline gap-3">
                <span className="mono !tracking-[.12em] !text-[10.5px]">SCENE {s.n} ·</span>
                <input type="number" min={0} max={600} value={s.secs} aria-label="Seconds" className="ak-secs"
                  onChange={(e) => edit((d) => ({ ...d, scenes: d.scenes.map((x, i) => (i === idx ? { ...x, secs: Number(e.target.value) || 0, by: "you", at: Date.now() } : x)) }))} />
                <span className="mono-s">S</span>
                <input className="ak-scene-title" value={s.title} placeholder="Scene title" aria-label="Scene title"
                  onChange={(e) => edit((d) => ({ ...d, scenes: d.scenes.map((x, i) => (i === idx ? { ...x, title: e.target.value, by: "you", at: Date.now() } : x)) }))} />
                {doc.scenes.length > 1 && (
                  <button type="button" className="ak-act is-muted ml-auto" title="Remove this scene"
                    onClick={() => edit((d) => ({ ...d, scenes: d.scenes.filter((_, i) => i !== idx).map((x, i) => ({ ...x, n: i + 1 })) }))}>×</button>
                )}
              </div>
              <MentionText value={s.prose} known={castNames} rows={3} placeholder="What happens. Write @Name for anyone or anything the cast should carry."
                onChange={(v) => edit((d) => ({ ...d, scenes: d.scenes.map((x, i) => (i === idx ? { ...x, prose: v, by: "you", at: Date.now() } : x)) }))} />
              {/* Who wrote this scene's words, and a way to have the model try again — as a proposal, never over your edit (brief 1.8). */}
              <div className="ak-scene-foot">
                <span className="mono-s">{s.by ? (s.by === "you" ? "BY YOU" : `BY ${s.by.split("/").pop()}`) : ""}</span>
                <button type="button" className="ak-act" disabled={regen != null} onClick={() => regenerate(idx)}>{regen === s.n ? "Rewriting…" : `Regenerate · ≈ ${regenCr} cr`}</button>
              </div>
              {proposal && proposal.n === s.n && (
                <div className="ak-proposal">
                  <span className="mono-s">PROPOSED BY {proposal.model.split("/").pop()} · {proposal.scene.secs}s · {proposal.credits}</span>
                  {proposal.scene.title && <span className="font-medium">{proposal.scene.title}</span>}
                  <p className="text-[13.5px] leading-relaxed">{proposal.scene.prose}</p>
                  <div className="flex gap-2">
                    <button type="button" className="btn-primary !h-8 !px-3 !text-[12.5px]" onClick={() => acceptProposal(idx)}>Use this</button>
                    <button type="button" className="chip" onClick={() => setProposal(null)}>Keep mine</button>
                  </div>
                </div>
              )}
            </div>
          ))}
          <button type="button" className="btn-dashed self-start !px-3 !py-2" onClick={() => edit((d) => ({ ...d, scenes: [...d.scenes, { n: d.scenes.length + 1, title: "", secs: 5, prose: "" }] }))}>+ Scene</button>
        </article>
      </section>

      <aside className="ak-trt-rail">
        <div className="ak-rail-tabs">
          <button type="button" className={`subnav-item ${tab === "cast" ? "is-on" : ""}`} onClick={() => setTab("cast")}>Cast found</button>
          <button type="button" className={`subnav-item ${tab === "notes" ? "is-on" : ""}`} onClick={() => setTab("notes")}>Notes · {doc.notes.length}</button>
        </div>
        <div className="ws-rail-body !gap-3.5">
          {tab === "cast" ? (
            <>
              <p className="ak-sub !text-[12.5px]">Every @name in the treatment becomes a cast entry. Give each a still and a line here, and Particl gets them with the shot list.</p>
              <div className="flex flex-col gap-1.5">
                {mentions.map(([n, count]) => {
                  const m = (data?.cast ?? []).find((c) => c.name.toLowerCase() === n.toLowerCase());
                  const st = castState(n);
                  return (
                    <div key={n} className="ak-cast-row">
                      <span className="ak-cast-thumb">
                        {m?.uploadId && /* eslint-disable-next-line @next/next/no-img-element */
                          <img src={`/api/uploads/${m.uploadId}`} alt="" loading="lazy" />}
                      </span>
                      <span className="flex min-w-0 flex-col gap-[3px]">
                        <span className="text-[13px] font-semibold leading-[1.1]">@{n}</span>
                        <span className="ak-sub !text-[11.5px]">{kindWord(n)} · {count} mention{count === 1 ? "" : "s"}</span>
                      </span>
                      {st.word === "NOT CAST"
                        ? <button type="button" className="ak-act" onClick={() => addToCast(n)}>ADD TO CAST</button>
                        : <span className={`ak-state !text-[9.5px] ${st.cls}`}><span className={`dot !h-1.5 !w-1.5 ${st.cls === "is-approved" ? "dot-approved" : st.cls === "is-ink" ? "dot-picked" : "dot-draft"}`} />{st.word}</span>}
                    </div>
                  );
                })}
                {mentions.length === 0 && <span className="ak-sub !text-[12px]">No @names yet.</span>}
              </div>
              <a href="/studio" className="hdr-mono-link self-start">GIVE THEM STILLS IN THE STUDIO →</a>
            </>
          ) : (
            <NotesTab doc={doc} me={me ?? "—"} projectId={projectId} onChange={(notes) => edit((d) => ({ ...d, notes }))} />
          )}
        </div>
      </aside>
    </div>
  );
}

/** Notes in the margin: who, which scene, what. */
function NotesTab({ doc, me, projectId, onChange }: { doc: Doc; me: string; projectId: string; onChange: (n: Note[]) => void }) {
  /* A half-written note survives switching to the Cast tab or leaving. */
  const { value: text, set: setText, clear: clearText } = useDraft(`atomik-note:${projectId}`, "");
  const [scene, setScene] = useState(1);
  function add() {
    if (!text.trim()) return;
    onChange([{ id: `n_${Date.now().toString(36)}`, by: me, scene, text: text.trim(), at: Date.now() }, ...doc.notes]);
    clearText();
  }
  return (
    <>
      <span className="mono !tracking-[.14em] !text-[10px]">NOTES IN THE MARGIN</span>
      <div className="flex flex-col gap-2">
        {doc.notes.map((n, i) => (
          <div key={n.id} className={`ak-note ${i === 0 ? "is-latest" : ""}`}>
            <span className="mono-s !text-[11px] !font-medium">{initials(n.by)} · SCENE {n.scene}</span>
            <span className="text-[12.5px] leading-[1.45]">{n.text}</span>
            <button type="button" className="ak-act is-muted self-start !text-[9.5px]" onClick={() => onChange(doc.notes.filter((x) => x.id !== n.id))}>REMOVE</button>
          </div>
        ))}
        {doc.notes.length === 0 && <span className="ak-sub !text-[12px]">Nothing in the margin yet.</span>}
      </div>
      <div className="flex flex-col gap-2 border-t border-hair pt-3">
        <label className="chip-dd self-start !py-1.5">Scene
          <select value={scene} onChange={(e) => setScene(Number(e.target.value))} aria-label="Scene">
            {doc.scenes.map((s) => <option key={s.n} value={s.n}>{s.n}</option>)}
          </select><span className="hdr-caret" aria-hidden="true">▼</span>
        </label>
        <textarea className="rail-prompt !min-h-[72px]" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="A note for the scene." />
        <button type="button" className="btn-secondary self-end" onClick={add} disabled={!text.trim()}>Add note</button>
      </div>
    </>
  );
}
