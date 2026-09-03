"use client";

/**
 * The Studio — where a project's visual vocabulary is kept.
 *
 * Artlist's insight is that the hard part of AI film isn't making one good
 * shot, it's making the second one match; Higgsfield's is that a face you
 * have TRAINED comes back as itself, where a face you describe comes back
 * as a stranger. Both are problems of recall, and both are solved by
 * writing the answer down once:
 *
 *   • Identities — a real face, learned from photos, rendered as itself
 *   • the Camera — the craft bank, browsable, with the shots that used it
 *   • the Cast — who, where and what this production keeps returning to
 *   • the shot controls — framing, camera, light, look, told as chips
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useProject } from "@/lib/projectContext";
import { uploadFile } from "@/lib/uploadClient";
import { CATEGORIES, specToPhrase, specCount, composePrompt, type ShotSpec } from "@/lib/studio";
import { appAlert, appConfirm, appPrompt } from "@/components/dialog";
import { IconPlus, IconClose, IconSparkle } from "@/components/Icons";
import ParticlLockup, { Empty, ParticlSpinner } from "@/components/ParticlMark";
import LazyMedia from "@/components/LazyMedia";
import IdentitySheet, { type IdentityView, type IdentityTerms } from "@/components/IdentitySheet";
import CreditStrip from "@/components/CreditStrip";
import { usePageTitle } from "@/lib/usePageTitle";
import { timeAgo } from "@/lib/format";
import type { CastMember } from "@/lib/cast";
import type { Gen } from "@/components/GenCard";

const KINDS = [
  { id: "character", label: "Character", blurb: "A face the project returns to." },
  { id: "location", label: "Location", blurb: "A place that has to stay the same place." },
  { id: "prop", label: "Prop", blurb: "An object that must be the same object." },
  { id: "style", label: "Look", blurb: "A treatment you keep reaching for." },
] as const;

const NO_TERMS: IdentityTerms = {
  configured: false, trainer: "", minPhotos: 5, maxPhotos: 40, recommended: "10 to 20",
  steps: 1500, trainCostUsd: 3.6, renderUsdPerMp: 0.035,
};

export default function StudioPage() {
  usePageTitle("Studio");
  const { selection: bin } = useProject();
  const router = useRouter();
  const scoped = bin !== "all" && bin !== "unfiled";
  const q = scoped ? `?projectId=${encodeURIComponent(bin)}` : "";

  const { data: castData, refresh: refreshCast } =
    useApi<{ cast: CastMember[] }>(`/api/cast${q}`, 0);
  const { data: idData, refresh: refreshIds } =
    useApi<{ identities: IdentityView[]; terms: IdentityTerms }>(`/api/identities${q}`, 0);
  // The bank's shop window borrows its previews from the library: the
  // newest render made with each move.
  const { data: recent } = useApi<{ generations: Gen[] }>(`/api/jobs?limit=120&sync=0${scoped ? `&projectId=${encodeURIComponent(bin)}` : ""}`, 0);

  const [spec, setSpec] = useState<ShotSpec>({});
  const [prose, setProse] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingKind, setPendingKind] = useState<CastMember["kind"]>("character");
  const [openId, setOpenId] = useState<string | "new" | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const cast = castData?.cast ?? [];
  const identities = useMemo(() => idData?.identities ?? [], [idData]);
  const terms = idData?.terms ?? NO_TERMS;
  const n = specCount(spec);
  const phrase = specToPhrase(spec);
  const preview = useMemo(() => composePrompt(prose, spec), [prose, spec]);

  // A face mid-training changes state without anyone touching the page.
  const anyTraining = identities.some((i) => i.status === "training");
  useEffect(() => {
    if (!anyTraining) return;
    const t = setInterval(refreshIds, 15000);
    return () => clearInterval(t);
  }, [anyTraining, refreshIds]);

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

  /* ── Hand off to the composer ─────────────────────────────────────── */
  const sendToGenerate = useCallback(() => {
    try {
      if (prose.trim()) window.localStorage.setItem("aw_compose_seed", prose.trim());
      window.localStorage.setItem("aw_compose_spec", JSON.stringify(spec));
    } catch { /* private mode — the composer just opens empty */ }
    router.push("/");
  }, [prose, spec, router]);

  const openIdentity = openId === "new" ? null : identities.find((i) => i.id === openId) ?? null;

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
          second one match. Train a face from photos and it comes back as itself;
          name a face, a place or a prop once and it comes back exactly in every
          prompt afterwards.
        </p>

        {/* ── Identities ────────────────────────────────────────── */}
        <section className="mt-8">
          <div className="flex flex-wrap items-center gap-3">
            <p className="grouplabel !pb-0">Identities</p>
            <span className="text-[13px] text-mute">
              {identities.length
                ? `${identities.length} face${identities.length === 1 ? "" : "s"}${anyTraining ? " · one is training" : ""}`
                : "a real face, learned from photos"}
            </span>
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <CreditStrip vendor="fal" />
              <button onClick={() => setOpenId("new")} className="chip !text-blue"><IconPlus /> New identity</button>
            </span>
          </div>
          <p className="mt-2 max-w-[72ch] text-[13.5px] text-dim">
            Ten to twenty photos of one person teach a small model that face. Stills made
            with it carry the face itself, not a description of it, and @Name in any
            prompt carries a still of it into video.
            {!terms.configured && (
              <> Training runs on fal.ai, which isn&rsquo;t connected yet — an admin sets{" "}
                <code className="font-mono text-[12px]">FAL_KEY</code> in Vercel. Photos can be gathered meanwhile.</>
            )}
          </p>

          {identities.length === 0 ? (
            <div className="card mt-4">
              <Empty title="Nobody trained yet" line="Add an identity with a set of photos of one person, then train it." />
            </div>
          ) : (
            <div className="gal-grid mt-4">
              {identities.map((i) => (
                <button key={i.id} type="button" onClick={() => setOpenId(i.id)} className="gal-card card-link">
                  <span className="gal-cover bg-thumb">
                    {i.coverUploadId
                      ? /* eslint-disable-next-line @next/next/no-img-element */
                        <img src={`/api/uploads/${i.coverUploadId}`} alt={i.name} className="absolute inset-0 h-full w-full object-cover" loading="lazy" />
                      : <span className="absolute inset-0 grid place-items-center font-mono text-[22px] text-mute">@</span>}
                    <span className={`gal-tag ${i.status === "ready" ? "!bg-ok !text-white" : i.status === "training" ? "!bg-blue !text-white" : i.status === "failed" ? "!bg-lift !text-white" : ""}`}>
                      {i.status === "ready" ? "Ready" : i.status === "training" ? "Training" : i.status === "failed" ? "Failed" : "Draft"}
                    </span>
                    <span className="gal-tag gal-tag-right">{i.photos.length} photo{i.photos.length === 1 ? "" : "s"}</span>
                  </span>
                  <span className="gal-body">
                    <span className="gal-name">@{i.name}</span>
                    <span className="gal-blurb">{i.description || "—"}</span>
                    <span className="gal-cat">
                      {i.status === "ready" && i.trainedAt ? `trained ${timeAgo(i.trainedAt)}` : i.status === "training" ? "at the trainer" : i.status === "failed" ? "try again" : "not trained"}
                    </span>
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
            {n > 0 && <span className="ml-auto"><button onClick={() => setSpec({})} className="chip !text-lift">Clear</button></span>}
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
              <IconSparkle className="!h-4 !w-4" /> Take it to Video
            </button>
            <span className="text-[13px] text-mute">
              Nothing is rendered here — the composer keeps the model, duration
              and references.
            </span>
          </div>
        </section>
      </div>

      {openId && (
        <IdentitySheet
          key={openId}
          identity={openIdentity}
          projectId={scoped ? bin : null}
          terms={terms}
          onClose={() => setOpenId(null)}
          onChanged={refreshIds}
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
