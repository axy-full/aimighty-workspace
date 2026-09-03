"use client";

/**
 * The Studio — where a project's visual vocabulary is kept.
 *
 * Artlist's insight is that the hard part of AI film isn't making one good
 * shot, it's making the second one match; Higgsfield's is that a look you
 * can SEE and name gets used, and a look you have to describe does not.
 * Both are problems of recall, and both are solved by writing the answer
 * down once, with a picture:
 *
 *   • Looks — a named style: chips, a style block, references, a cover
 *   • the Camera — the craft bank, browsable, with the shots that used it
 *   • the Cast — who, where and what this production keeps returning to
 *   • the shot controls — framing, camera, light, look, told as chips
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useProject } from "@/lib/projectContext";
import { uploadFile } from "@/lib/uploadClient";
import { CATEGORIES, specToPhrase, specCount, composePrompt, type ShotSpec } from "@/lib/studio";
import { appAlert, appConfirm, appPrompt } from "@/components/dialog";
import { IconPlus, IconClose, IconSparkle } from "@/components/Icons";
import ParticlLockup, { Empty, ParticlSpinner } from "@/components/ParticlMark";
import LazyMedia from "@/components/LazyMedia";
import LookSheet, { type LookItem, type LookCover } from "@/components/LookSheet";
import { usePageTitle } from "@/lib/usePageTitle";
import type { CastMember } from "@/lib/cast";
import type { Gen } from "@/components/GenCard";

const KINDS = [
  { id: "character", label: "Character", blurb: "A face the project returns to." },
  { id: "location", label: "Location", blurb: "A place that has to stay the same place." },
  { id: "prop", label: "Prop", blurb: "An object that must be the same object." },
  { id: "style", label: "Look", blurb: "A treatment you keep reaching for." },
] as const;

export default function StudioPage() {
  usePageTitle("Studio");
  const { selection: bin } = useProject();
  const router = useRouter();
  const scoped = bin !== "all" && bin !== "unfiled";
  const q = scoped ? `?projectId=${encodeURIComponent(bin)}` : "";

  const { data: castData, refresh: refreshCast } =
    useApi<{ cast: CastMember[] }>(`/api/cast${q}`, 0);
  const { data: lookData, refresh: refreshLooks } =
    useApi<{ presets: LookItem[]; categories: string[] }>(`/api/presets${q}`, 0);
  // The bank's shop window borrows its previews from the library: the
  // newest render made with each move.
  const { data: recent } = useApi<{ generations: Gen[] }>(`/api/jobs?limit=120&sync=0${scoped ? `&projectId=${encodeURIComponent(bin)}` : ""}`, 0);

  const [spec, setSpec] = useState<ShotSpec>({});
  const [prose, setProse] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingKind, setPendingKind] = useState<CastMember["kind"]>("character");
  const [lookFilter, setLookFilter] = useState<string>("All");
  const [lookQuery, setLookQuery] = useState("");
  const [openLook, setOpenLook] = useState<LookItem | null>(null);
  const [editing, setEditing] = useState<LookItem | "new" | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const cast = castData?.cast ?? [];
  const looks = useMemo(() => lookData?.presets ?? [], [lookData]);
  const categories = useMemo(() => {
    const present = new Set(looks.map((l) => l.category));
    return ["All", ...(lookData?.categories ?? []).filter((c) => present.has(c))];
  }, [looks, lookData]);
  const shownLooks = useMemo(() => {
    const needle = lookQuery.trim().toLowerCase();
    return looks.filter((l) =>
      (lookFilter === "All" || l.category === lookFilter) &&
      (!needle || `${l.name} ${l.blurb} ${l.category}`.toLowerCase().includes(needle)));
  }, [looks, lookFilter, lookQuery]);
  const n = specCount(spec);
  const phrase = specToPhrase(spec);
  const preview = useMemo(() => composePrompt(prose, spec), [prose, spec]);

  const toggle = (cat: string, value: string) =>
    setSpec((s) => ({ ...s, [cat]: s[cat] === value ? "" : value }));

  /* ── Camera previews: which render last used each move ────────────── */
  const movePreview = useMemo(() => {
    const map = new Map<string, Gen>();
    for (const g of recent?.generations ?? []) {
      if (g.status !== "succeeded" || !g.storedUrl) continue;
      const sp = (g.params as { shotSpec?: ShotSpec }).shotSpec;
      const key = sp?.move || sp?.technique;
      if (key && !map.has(key)) map.set(key, g);
    }
    return map;
  }, [recent]);

  /* ── Cast ─────────────────────────────────────────────────────────── */
  async function addFrom(files: FileList) {
    const f = files[0];
    if (!f) return;
    const name = await appPrompt(`Name this ${pendingKind === "style" ? "look" : pendingKind}`, "",
      pendingKind === "character" ? "e.g. Maya"
        : pendingKind === "location" ? "e.g. HarbourSet"
        : pendingKind === "prop" ? "e.g. RedHelmet" : "e.g. NoirLook");
    if (!name?.trim()) return;
    const description = await appPrompt("Describe it in a line", "",
      pendingKind === "character" ? "e.g. mid-30s, close-cropped hair, navy overcoat"
        : pendingKind === "prop" ? "e.g. scuffed red motorcycle helmet, matte finish"
        : "e.g. a wet harbour at night, sodium lights");
    if (description === null) return;
    setBusy(true);
    try {
      const up = await uploadFile(f, "reference");
      const res = await fetch("/api/cast", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(), kind: pendingKind, description,
          uploadId: up.id, projectId: scoped ? bin : null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not add");
      refreshCast();
    } catch (e) {
      await appAlert("Could not add", (e as Error).message);
    } finally { setBusy(false); }
  }

  async function removeCast(m: CastMember) {
    if (!(await appConfirm(`Remove @${m.name}?`,
      "Prompts that cite the name will stop resolving.",
      { confirmLabel: "Remove", danger: true }))) return;
    await fetch(`/api/cast/${m.id}`, { method: "DELETE" });
    refreshCast();
  }

  /* ── Looks ────────────────────────────────────────────────────────── */
  async function saveCurrentAsLook() {
    if (!n && !prose.trim()) { await appAlert("Set at least one control first, or write a style block."); return; }
    setEditing("new");
  }

  /** Carry a Look into the composer: its chips, and the Look itself. */
  const carryLook = useCallback((l: LookItem) => {
    try {
      window.localStorage.setItem("aw_compose_spec", JSON.stringify(l.spec));
      window.localStorage.setItem("aw_compose_look", JSON.stringify({ id: l.id, name: l.name }));
      if (prose.trim()) window.localStorage.setItem("aw_compose_seed", prose.trim());
    } catch { /* private mode — the composer just opens empty */ }
    router.push("/");
  }, [prose, router]);

  async function duplicateLook(l: LookItem) {
    const name = await appPrompt("Name your copy", `${l.name} (mine)`, "");
    if (!name?.trim()) return;
    const res = await fetch("/api/presets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(), category: l.category, blurb: l.blurb, spec: l.spec, prose: l.prose,
        refs: l.refs, swatch: l.swatch, projectId: scoped ? bin : null,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { await appAlert("Could not copy", json.error); return; }
    setOpenLook(null); refreshLooks();
  }

  async function deleteLook(l: LookItem) {
    if (!(await appConfirm(`Delete "${l.name}"?`, "Renders made in it keep their prompts.",
      { confirmLabel: "Delete", danger: true }))) return;
    const res = await fetch(`/api/presets/${l.id}`, { method: "DELETE" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { await appAlert("Could not delete", json.error); return; }
    setOpenLook(null); refreshLooks();
  }

  /* ── Hand off to the composer ─────────────────────────────────────── */
  const sendToGenerate = useCallback(() => {
    try {
      if (prose.trim()) window.localStorage.setItem("aw_compose_seed", prose.trim());
      window.localStorage.setItem("aw_compose_spec", JSON.stringify(spec));
    } catch { /* private mode — the composer just opens empty */ }
    router.push("/");
  }, [prose, spec, router]);

  return (
    <div className="screen">
      <div className="mx-auto w-full max-w-[1120px] pb-10">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-6">
          <h1><ParticlLockup /></h1>
          <span className="text-[15px] text-dim">
            {scoped ? "this project" : "the whole workspace"}
          </span>
        </div>
        <p className="mt-3 max-w-[64ch] text-[15px] text-dim">
          The hard part isn&rsquo;t making one good shot, it&rsquo;s making the
          second one match. Name a look, a face, a place or a prop once here, and it
          comes back exactly in every prompt afterwards.
        </p>

        {/* ── Looks ─────────────────────────────────────────────── */}
        <section className="mt-8">
          <div className="flex flex-wrap items-center gap-3">
            <p className="grouplabel !pb-0">Looks</p>
            <span className="text-[13px] text-mute">{looks.length} in the library</span>
            <span className="ml-auto flex items-center gap-2">
              <input value={lookQuery} onChange={(e) => setLookQuery(e.target.value)} placeholder="Search looks"
                className="ctl !h-[34px] w-[180px] !text-[14px]" />
              <button onClick={() => setEditing("new")} className="chip !text-blue"><IconPlus /> New look</button>
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {categories.map((c) => (
              <button key={c} onClick={() => setLookFilter(c)}
                className={`chip !py-1.5 !text-[13px] ${lookFilter === c ? "bg-blue text-white" : ""}`}>
                {c}
              </button>
            ))}
          </div>

          {shownLooks.length === 0 ? (
            <div className="card mt-4"><Empty title="No looks here" line="Try another category, or make one from the controls below." /></div>
          ) : (
            <div className="look-grid mt-4">
              {shownLooks.map((l) => (
                <button key={l.id} type="button" onClick={() => setOpenLook(l)} className="look-card card-link">
                  <span className="look-cover" style={{ background: `linear-gradient(135deg, ${l.swatch[0]}, ${l.swatch[1]})` }}>
                    {l.cover && <LazyMedia url={l.cover.url} kind={l.cover.kind} hoverPlay alt={l.name} className="!absolute inset-0" />}
                    {l.builtin && <span className="look-tag">Particl</span>}
                    {l.refs.length > 0 && <span className="look-tag look-tag-right">{l.refs.length} ref{l.refs.length === 1 ? "" : "s"}</span>}
                  </span>
                  <span className="look-body">
                    <span className="look-name">{l.name}</span>
                    <span className="look-blurb">{l.blurb || specToPhrase(l.spec) || "—"}</span>
                    <span className="look-cat">{l.category}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* ── The Camera ────────────────────────────────────────── */}
        <section className="card mt-8 px-5 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="grouplabel !pb-0">The camera</p>
            <span className="text-[13px] text-mute">
              The bank — every move, written so the engine can&rsquo;t mistake it. Where a render used one, it shows.
            </span>
          </div>
          <div className="camera-grid mt-4">
            {(["move", "technique"] as const).flatMap((key) => {
              const cat = CATEGORIES.find((c) => c.key === key)!;
              return cat.options.map((o) => {
                const g = movePreview.get(o.value);
                const on = spec[key] === o.value;
                return (
                  <button key={`${key}-${o.value}`} type="button" onClick={() => toggle(key, o.value)}
                    title={o.module || o.phrase} className={`camera-card ${on ? "is-on" : ""}`}>
                    <span className="camera-preview">
                      {g?.storedUrl
                        ? <LazyMedia url={g.storedUrl} kind={g.kind === "image" ? "image" : "video"} hoverPlay alt={o.label} className="!absolute inset-0" />
                        : <span className="camera-none">no take yet</span>}
                    </span>
                    <span className="camera-name">{o.label}</span>
                    <span className="camera-kind">{key === "technique" ? "technique" : "move"}</span>
                  </button>
                );
              });
            })}
          </div>
        </section>

        {/* ── Cast ─────────────────────────────────────────────── */}
        <section className="card mt-6 px-5 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="grouplabel !pb-0">Cast</p>
            <span className="ml-auto flex flex-wrap gap-1.5">
              {KINDS.map((k) => (
                <button key={k.id} title={k.blurb}
                  onClick={() => { setPendingKind(k.id); file.current?.click(); }}
                  disabled={busy} className="chip disabled:opacity-50">
                  <IconPlus className="!h-3 !w-3" /> {k.label}
                </button>
              ))}
            </span>
          </div>
          <input ref={file} type="file" accept="image/*" hidden
            onChange={(e) => { if (e.target.files) addFrom(e.target.files); e.target.value = ""; }} />

          {cast.length === 0 ? (
            <Empty title="Nobody cast yet"
              line="Add a character, a place or a prop with a still and a line of description, then write @TheirName in any prompt." />
          ) : (
            <div className="mt-4 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
              {cast.map((m) => (
                <div key={m.id} className="group relative overflow-hidden rounded-[var(--r)] bg-panel2">
                  <div className="aspect-[4/3] w-full bg-thumb">
                    {m.uploadId && (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={`/api/uploads/${m.uploadId}`} alt={m.name}
                        className="h-full w-full object-cover" />
                    )}
                  </div>
                  <div className="px-3 py-2">
                    <p className="flex items-baseline gap-2">
                      <span className="truncate font-mono text-[13px] font-medium text-ink">@{m.name}</span>
                      <span className="text-[11px] uppercase tracking-wide text-mute">
                        {m.kind === "style" ? "look" : m.kind}
                      </span>
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-[12px] text-mute">{m.description || "—"}</p>
                    <button onClick={() => setProse((p) => `${p}${p && !p.endsWith(" ") ? " " : ""}@${m.name} `)}
                      className="mt-1.5 text-[12px] text-blue">Cite</button>
                  </div>
                  <button onClick={() => removeCast(m)} aria-label={`Remove ${m.name}`}
                    className="reveal absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-black/55 text-white">
                    <IconClose className="!h-3 !w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── The shot ─────────────────────────────────────────── */}
        <section className="card mt-6 px-5 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="grouplabel !pb-0">The shot</p>
            {n > 0 && <span className="chip bg-blue text-white">{n} set</span>}
            <span className="ml-auto flex gap-1.5">
              <button onClick={saveCurrentAsLook} className="chip">Save as look</button>
              {n > 0 && <button onClick={() => setSpec({})} className="chip !text-lift">Clear</button>}
            </span>
          </div>
          {phrase && <p className="mt-2 text-[13px] text-dim"><span className="text-mute">Reads as: </span>{phrase}.</p>}

          <div className="mt-4 grid gap-x-8 gap-y-5 md:grid-cols-2">
            {CATEGORIES.map((c) => (
              <div key={c.key}>
                <p className="text-[12px] font-medium uppercase tracking-wide text-mute">{c.label}</p>
                {c.hint && <p className="mt-0.5 text-[12px] leading-snug text-mute">{c.hint}</p>}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {c.options.map((o) => (
                    <button key={o.value} onClick={() => toggle(c.key, o.value)} title={o.phrase}
                      className={`chip ${spec[c.key] === o.value ? "bg-blue text-white" : ""}`}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── The prompt ───────────────────────────────────────── */}
        <section className="card mt-6 px-5 py-5">
          <p className="grouplabel">The prompt</p>
          <textarea
            value={prose} onChange={(e) => setProse(e.target.value)}
            placeholder="What happens in the shot? Subject and action — the chips above handle how it looks."
            rows={3}
            className="mt-3 w-full resize-none rounded-[12px] bg-chip px-3.5 py-3 text-[15px] text-bone placeholder:text-mute focus:bg-panel focus:outline-none"
          />
          {(prose.trim() || phrase) && (
            <div className="mt-3 rounded-[var(--r)] bg-panel2 px-4 py-3">
              <p className="grouplabel">Reads as</p>
              <p className="mt-1.5 text-[14px] leading-relaxed text-dim">{preview}</p>
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button onClick={sendToGenerate}
              disabled={!prose.trim() && !n}
              className="inline-flex items-center gap-2 rounded-full bg-blue px-5 py-2.5 text-[15px] font-medium text-white disabled:opacity-40">
              <IconSparkle className="!h-4 !w-4" /> Take it to Generate
            </button>
            <span className="text-[13px] text-mute">
              Nothing is rendered here — the composer keeps the model, duration
              and references.
            </span>
          </div>
        </section>
      </div>

      {openLook && !editing && (
        <LookSheet
          look={openLook}
          onClose={() => setOpenLook(null)}
          onUse={() => carryLook(openLook)}
          onEdit={openLook.builtin ? undefined : () => setEditing(openLook)}
          onDuplicate={() => duplicateLook(openLook)}
          onDelete={openLook.builtin ? undefined : () => deleteLook(openLook)}
        />
      )}
      {editing && (
        <LookEditor
          look={editing === "new" ? null : editing}
          seedSpec={editing === "new" ? spec : undefined}
          seedProse={editing === "new" ? "" : undefined}
          projectId={scoped ? bin : null}
          categories={lookData?.categories ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); setOpenLook(null); refreshLooks(); }}
        />
      )}
      {busy && (
        <div className="fixed bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-full bg-panel px-4 py-2 text-[13px] shadow-[var(--shadow-pop)]">
          <ParticlSpinner size={14} className="mr-2 inline-block align-middle text-dim" /> Adding…
        </div>
      )}
    </div>
  );
}

/* ── The Look editor ─────────────────────────────────────────────────── */

function LookEditor({ look, seedSpec, seedProse, projectId, categories, onClose, onSaved }: {
  look: LookItem | null;
  seedSpec?: ShotSpec; seedProse?: string;
  projectId: string | null;
  categories: string[];
  onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(look?.name ?? "");
  const [category, setCategory] = useState(look?.category ?? "Custom");
  const [blurb, setBlurb] = useState(look?.blurb ?? "");
  const [prose, setProse] = useState(look?.prose ?? seedProse ?? "");
  const [spec, setSpec] = useState<ShotSpec>(look?.spec ?? seedSpec ?? {});
  const [refs, setRefs] = useState<{ id: string; url: string }[]>(
    (look?.refs ?? []).map((id) => ({ id, url: `/api/uploads/${id}` })));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const n = specCount(spec);

  async function addRefs(files: FileList) {
    setBusy("Uploading…"); setErr(null);
    try {
      const next: { id: string; url: string }[] = [];
      for (const f of Array.from(files).slice(0, 6 - refs.length)) {
        const up = await uploadFile(f, "reference", (pct) => setBusy(`${f.name} — ${pct}%`));
        if (up.kind !== "image") throw new Error("A look's references are stills.");
        next.push({ id: up.id, url: up.url });
      }
      setRefs((r) => [...r, ...next]);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); if (file.current) file.current.value = ""; }
  }

  async function describe() {
    if (!look) { setErr("Save the look first, then let Claude describe its references."); return; }
    setBusy("Looking at the references…"); setErr(null);
    try {
      const res = await fetch(`/api/presets/${look.id}/describe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't describe it");
      setProse(json.prose); setCost(json.costUsd ?? null);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }

  async function save() {
    if (!name.trim()) { setErr("Give the look a name."); return; }
    setBusy("Saving…"); setErr(null);
    try {
      const body = { name: name.trim(), category, blurb: blurb.trim(), prose: prose.trim(), spec, refs: refs.map((r) => r.id), projectId };
      const res = look
        ? await fetch(`/api/presets/${look.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        : await fetch("/api/presets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't save");
      onSaved();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }

  const toggle = (cat: string, value: string) =>
    setSpec((s) => ({ ...s, [cat]: s[cat] === value ? "" : value }));

  return (
    <div className="sheet-veil" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={look ? `Edit ${look.name}` : "New look"}>
        <header className="sheet-head">
          <span className="text-[16px] font-semibold tracking-[-0.01em]">{look ? "Edit look" : "New look"}</span>
          <button type="button" onClick={onClose} className="theatre-close" title="Close"><IconClose /></button>
        </header>
        <div className="sheet-body">
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-dim">Name</span>
            <input className="ctl" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rooftop golden" />
          </label>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-dim">Category</span>
              <select className="ctl" value={category} onChange={(e) => setCategory(e.target.value)}>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-dim">One line</span>
              <input className="ctl" value={blurb} onChange={(e) => setBlurb(e.target.value)} placeholder="What it does, in a breath" maxLength={140} />
            </label>
          </div>

          <p className="mt-4 text-[13px] font-medium text-dim">Reference stills <span className="font-normal text-mute">· up to six, attached to every render made in this look</span></p>
          <div className="mt-2 flex flex-wrap gap-2">
            {refs.map((r) => (
              <span key={r.id} className="ref-thumb group">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={r.url} alt="" className="h-full w-full object-cover" />
                <button type="button" onClick={() => setRefs((x) => x.filter((y) => y.id !== r.id))} className="ref-x reveal" title="Remove"><IconClose className="!h-3 !w-3" /></button>
              </span>
            ))}
            {refs.length < 6 && (
              <button type="button" onClick={() => file.current?.click()} className="ref-thumb ref-add" title="Add stills"><IconPlus /></button>
            )}
            <input ref={file} type="file" multiple hidden accept="image/jpeg,image/png,image/webp"
              onChange={(e) => e.target.files && addRefs(e.target.files)} />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium text-dim">Style block</span>
            <span className="text-[12px] text-mute">light, lens, grade, texture — never the subject</span>
            {refs.length > 0 && look && (
              <button type="button" onClick={describe} disabled={Boolean(busy)} className="chip ml-auto !py-1 !text-[12.5px] !text-blue disabled:opacity-50">
                <IconSparkle className="!h-3.5 !w-3.5" /> Describe from the stills
              </button>
            )}
          </div>
          <textarea value={prose} onChange={(e) => setProse(e.target.value)} rows={4}
            placeholder="e.g. A single soft daylight source from a window to one side, dust visible in the beam, warm bounce off pale walls. Gentle contrast, shadows open."
            className="mt-2 w-full resize-none rounded-[12px] bg-chip px-3.5 py-3 text-[14px] leading-relaxed text-bone placeholder:text-mute focus:bg-panel focus:outline-none" />
          {cost != null && <p className="mt-1 text-[12px] text-mute">Described for {cost < 0.01 ? "under a cent" : `$${cost.toFixed(2)}`}. Edit it as you like before saving.</p>}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium text-dim">Chips</span>
            {n > 0 && <span className="text-[12px] text-mute">{specToPhrase(spec)}</span>}
            {n > 0 && <button type="button" onClick={() => setSpec({})} className="ml-auto text-[12px] text-lift">Clear</button>}
          </div>
          <div className="mt-2 grid gap-x-6 gap-y-3 md:grid-cols-2">
            {CATEGORIES.map((c) => (
              <div key={c.key}>
                <p className="text-[11px] font-medium uppercase tracking-wide text-mute">{c.label}</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {c.options.map((o) => (
                    <button key={o.value} type="button" onClick={() => toggle(c.key, o.value)} title={o.phrase}
                      className={`chip !py-1 !text-[12.5px] ${spec[c.key] === o.value ? "bg-blue text-white" : ""}`}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {err && <p className="mt-4 rounded-[10px] bg-lift/8 px-3 py-2 text-[13.5px] text-lift">{err}</p>}
        </div>
        <footer className="sheet-foot">
          <span className="text-[12.5px] text-mute">{busy ?? (look ? "" : "Saved to " + (projectId ? "this project" : "the whole workspace"))}</span>
          <span className="ml-auto flex gap-2">
            <button type="button" onClick={onClose} className="chip">Cancel</button>
            <button type="button" onClick={save} disabled={Boolean(busy)} className="btn-render h-[36px] px-5 text-[14px]">
              {look ? "Save changes" : "Save look"}
            </button>
          </span>
        </footer>
      </div>
    </div>
  );
}

export type { LookCover };
