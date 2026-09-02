"use client";

/**
 * The Studio — where a project's visual vocabulary is kept.
 *
 * Artlist's insight is that the hard part of AI film isn't making one good
 * shot, it's making the second one match, and that most people describing a
 * shot leave out the things that decide how it looks. Both problems are
 * problems of RECALL, so both are solved by writing the answer down once:
 *
 *   • the Cast — who and where this production keeps returning to
 *   • the shot controls — framing, camera, light, look, told as chips
 *   • Looks — a whole set of those controls, saved and reapplied in one click
 *
 * The composer keeps its compact versions of the first two, for when you're
 * mid-flow. This is the room you come to when you're setting a project up, or
 * when you want the categories at a size you can actually read.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useProject } from "@/lib/projectContext";
import { uploadFile } from "@/lib/uploadClient";
import { CATEGORIES, specToPhrase, specCount, composePrompt, type ShotSpec } from "@/lib/studio";
import { appAlert, appConfirm, appPrompt } from "@/components/dialog";
import { IconPlus, IconClose, IconSparkle } from "@/components/Icons";
import ParticlLockup, { Empty } from "@/components/ParticlMark";
import { usePageTitle } from "@/lib/usePageTitle";
import type { CastMember } from "@/lib/cast";

type Preset = { id: string; name: string; projectId: string | null; spec: ShotSpec };

const KINDS = [
  { id: "character", label: "Character", blurb: "A face the project returns to." },
  { id: "location", label: "Location", blurb: "A place that has to stay the same place." },
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
  const { data: presetData, refresh: refreshPresets } =
    useApi<{ presets: Preset[] }>(`/api/presets${q}`, 0);

  const [spec, setSpec] = useState<ShotSpec>({});
  const [prose, setProse] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingKind, setPendingKind] = useState<CastMember["kind"]>("character");
  const file = useRef<HTMLInputElement>(null);

  const cast = castData?.cast ?? [];
  const presets = presetData?.presets ?? [];
  const n = specCount(spec);
  const phrase = specToPhrase(spec);
  const preview = useMemo(() => composePrompt(prose, spec), [prose, spec]);

  const toggle = (cat: string, value: string) =>
    setSpec((s) => ({ ...s, [cat]: s[cat] === value ? "" : value }));

  /* ── Cast ─────────────────────────────────────────────────────────── */
  async function addFrom(files: FileList) {
    const f = files[0];
    if (!f) return;
    const name = await appPrompt(`Name this ${pendingKind}`, "",
      pendingKind === "character" ? "e.g. Maya"
        : pendingKind === "location" ? "e.g. HarbourSet" : "e.g. NoirLook");
    if (!name?.trim()) return;
    const description = await appPrompt("Describe them in a line", "",
      pendingKind === "character" ? "e.g. mid-30s, close-cropped hair, navy overcoat"
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
  async function saveLook() {
    if (!n) { await appAlert("Set at least one control first."); return; }
    const name = await appPrompt("Name this look", "", "e.g. Rooftop golden");
    if (!name?.trim()) return;
    const res = await fetch("/api/presets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, spec, projectId: scoped ? bin : null }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { await appAlert("Could not save", json.error); return; }
    refreshPresets();
  }

  async function removeLook(p: Preset) {
    if (!(await appConfirm(`Delete "${p.name}"?`, undefined,
      { confirmLabel: "Delete", danger: true }))) return;
    await fetch(`/api/presets/${p.id}`, { method: "DELETE" });
    refreshPresets();
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
          second one match. Name a face, a place or a look once here, and cite
          it by name in any prompt afterwards.
        </p>

        {/* ── Cast ─────────────────────────────────────────────── */}
        <section className="card mt-8 px-5 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="grouplabel">Cast</p>
            <span className="ml-auto flex gap-1.5">
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
              line="Add a character with a still and a line of description, then write @TheirName in any prompt." />
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
            <p className="grouplabel">The shot</p>
            {n > 0 && <span className="chip bg-blue text-white">{n} set</span>}
            <span className="ml-auto flex gap-1.5">
              <button onClick={saveLook} className="chip">Save as look</button>
              {n > 0 && <button onClick={() => setSpec({})} className="chip !text-lift">Clear</button>}
            </span>
          </div>

          {presets.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] uppercase tracking-wide text-mute">Looks</span>
              {presets.map((p) => (
                <span key={p.id} className="group inline-flex items-center">
                  <button onClick={() => setSpec(p.spec)} className="chip">{p.name}</button>
                  <button onClick={() => removeLook(p)} aria-label={`Delete ${p.name}`}
                    className="reveal ml-0.5 text-[12px] text-mute">×</button>
                </span>
              ))}
            </div>
          )}

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
    </div>
  );
}
