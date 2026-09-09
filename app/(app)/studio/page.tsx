"use client";

/**
 * Studio · Cast & identities — from the pipeline handoff.
 *
 * The hard part isn't making one good shot, it's making the second one
 * match. Two answers, both written down once: an IDENTITY is a real face
 * learned from photos, rendered as itself; a CAST entry is a face, a place,
 * a prop or a look with a still and a line, cited by @name in any prompt.
 *
 * The page is a list on the left and a detail rail on the right: pick a
 * card and the rail shows its still, its description, everything made with
 * it, and how to write it into a prompt. Selection is ink on the card.
 */
import Link from "next/link";
import { startCastDrag } from "@/lib/dnd";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/lib/useApi";
import { useSearchParams } from "next/navigation";
import PaneDivider from "@/components/PaneDivider";
import { PANES, usePaneWidth } from "@/lib/panes";
import { useProject } from "@/lib/projectContext";
import { useSession } from "@/lib/session";
import { uploadFile } from "@/lib/uploadClient";
import { appAlert, appConfirm, appPrompt } from "@/components/dialog";
import { Empty, ParticlSpinner, Waiting } from "@/components/ParticlMark";
import LazyMedia from "@/components/LazyMedia";
import IdentitySheet, { type IdentityView, type IdentityTerms } from "@/components/IdentitySheet";
import { usePageTitle } from "@/lib/usePageTitle";
import { timeAgo } from "@/lib/format";
import { useIsMobile, useSheetLock } from "@/lib/useMobile";
import type { CastMember } from "@/lib/cast";
import type { Gen } from "@/components/GenCard";
import { useMoney } from "@/lib/price";
import RulesSection from "@/components/RulesSection";
import { usageSummary, usageLine as usageLineOf } from "@/lib/castUsage";

const KINDS: { id: CastMember["kind"]; label: string; badge: string; blurb: string }[] = [
  { id: "character", label: "Character", badge: "CHARACTER", blurb: "A face the production returns to." },
  { id: "location", label: "Location", badge: "LOCATION", blurb: "A place that has to stay the same place." },
  { id: "prop", label: "Prop", badge: "PROP", blurb: "An object that must be the same object." },
  { id: "style", label: "Look", badge: "LOOK", blurb: "A treatment you keep reaching for." },
];
const NO_TERMS: IdentityTerms = {
  configured: false, trainer: "", minPhotos: 5, maxPhotos: 40, recommended: "10 to 20",
  steps: 1500, trainCostUsd: 3.6, renderUsdPerMp: 0.035,
};
type Sel = { type: "cast"; id: string } | { type: "identity"; id: string } | null;

/* `useSearchParams` in a statically-renderable route needs a Suspense
   boundary or `next build` refuses the page — the same reason the shot
   builder next door is wrapped. Studio reads `?cast=` so the palette can
   land on a member, so it needs one too. */
export default function StudioPage() {
  return <Suspense fallback={<Waiting label="Opening Studio" />}><Studio /></Suspense>;
}

function Studio() {
  usePageTitle("Studio · Cast");
  const { signedIn } = useSession();
  const money = useMoney();
  const { selection: bin, current } = useProject();
  const scoped = bin !== "all" && bin !== "unfiled";
  const q = scoped ? `?projectId=${encodeURIComponent(bin)}` : "";

  const { data: castData, refresh: refreshCast } = useApi<{ cast: CastMember[] }>(signedIn ? `/api/cast${q}` : null, 0);
  const { data: idData, refresh: refreshIds } = useApi<{ identities: IdentityView[]; terms: IdentityTerms }>(signedIn ? `/api/identities${q}` : null, 0);
  // Usage — which shots and takes cited each name — is read off the library.
  const { data: recent } = useApi<{ generations: Gen[] }>(signedIn ? `/api/jobs?limit=200&sync=0${scoped ? `&projectId=${encodeURIComponent(bin)}` : ""}` : null, 0);

  const cast = useMemo(() => castData?.cast ?? [], [castData]);
  const identities = useMemo(() => idData?.identities ?? [], [idData]);
  const terms = idData?.terms ?? NO_TERMS;
  const gens = useMemo(() => recent?.generations ?? [], [recent]);

  const [filter, setFilter] = useState<"all" | CastMember["kind"]>("all");
  const [sel, setSel] = useState<Sel>(null);
  const [openId, setOpenId] = useState<string | "new" | null>(null);
  const [adding, setAdding] = useState(false);
  const [pendingKind, setPendingKind] = useState<CastMember["kind"]>("character");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const replaceFile = useRef<HTMLInputElement>(null);
  const mobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  useSheetLock(mobile && sheetOpen);
  const pick = (next: Sel) => { setSel(next); if (mobile) setSheetOpen(true); };

  /* `/studio?cast=<id>` selects that member. Studio holds its selection in
     React state, so before this the command palette could only land NEAR a
     cast member — on the list, with the person still to be found by eye.
     Seeded once, and only after the list arrives, because the id has to
     match something; going through `pick` so the mobile sheet opens too. */
  const [railW] = usePaneWidth(PANES.studio);
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const wantCast = useSearchParams().get("cast");
  /* React's "adjust state when the input changes" pattern, done during render
     rather than in an effect: the set functions belong to this component, so
     React re-renders before painting and the member never flashes unselected.
     `seededFor` remembers which id was honoured, so choosing someone else
     afterwards sticks — the URL does not keep pulling the selection back. */
  if (wantCast && wantCast !== seededFor && cast.some((c) => c.id === wantCast)) {
    setSeededFor(wantCast);
    setSel({ type: "cast", id: wantCast });
    if (mobile) setSheetOpen(true);
  }

  // A face mid-training changes state without anyone touching the page.
  const anyTraining = identities.some((i) => i.status === "training");
  useEffect(() => {
    if (!anyTraining) return;
    const t = setInterval(refreshIds, 15000);
    return () => clearInterval(t);
  }, [anyTraining, refreshIds]);

  /** Everything made with a name: the renders whose prompt cited it. */
  const usage = useMemo(() => {
    const map = new Map<string, Gen[]>();
    for (const g of gens) {
      for (const n of (g.params as { cast?: string[] }).cast ?? []) {
        const k = n.toLowerCase();
        (map.get(k) ?? map.set(k, []).get(k)!).push(g);
      }
    }
    return map;
  }, [gens]);
  const madeWith = (name: string) => usage.get(name.toLowerCase()) ?? [];
  const usageLine = (name: string) => {
    const list = madeWith(name);
    const shots = new Set(list.map((g) => g.shotCode).filter(Boolean)).size;
    return `${shots} SHOT${shots === 1 ? "" : "S"} · ${list.length} TAKE${list.length === 1 ? "" : "S"}`;
  };
  const identityFor = (name: string) => identities.find((i) => i.name.toLowerCase() === name.toLowerCase()) ?? null;

  const shownCast = filter === "all" ? cast : cast.filter((m) => m.kind === filter);
  const curCast = sel?.type === "cast" ? cast.find((m) => m.id === sel.id) ?? null : null;
  const curId = sel?.type === "identity" ? identities.find((i) => i.id === sel.id) ?? null : null;
  const cur = curCast ?? (curId ? null : cast[0] ?? null);

  /* ── Cast ─────────────────────────────────────────────────────────── */
  async function addFrom(files: FileList) {
    const f = files[0];
    if (!f) return;
    const kind = KINDS.find((k) => k.id === pendingKind)!;
    const name = await appPrompt(`Name this ${kind.label.toLowerCase()}`, "",
      pendingKind === "character" ? "e.g. Maya" : pendingKind === "location" ? "e.g. HarbourSet" : pendingKind === "prop" ? "e.g. RedHelmet" : "e.g. NoirLook");
    if (!name?.trim()) return;
    const description = await appPrompt("Describe it in a line", "",
      pendingKind === "character" ? "e.g. mid-30s, close-cropped hair, navy overcoat" : pendingKind === "prop" ? "e.g. scuffed red motorcycle helmet, matte finish" : "e.g. a wet harbour at night, sodium lights");
    if (description === null) return;
    setBusy(true);
    try {
      const up = await uploadFile(f, "reference");
      const res = await fetch("/api/cast", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), kind: pendingKind, description, uploadId: up.id, projectId: scoped ? bin : null }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not add");
      refreshCast();
      if (json.member?.id) setSel({ type: "cast", id: json.member.id });
    } catch (e) {
      await appAlert("Could not add", (e as Error).message);
    } finally { setBusy(false); }
  }
  async function patchCast(m: CastMember, body: Record<string, unknown>) {
    const res = await fetch(`/api/cast/${m.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) { await appAlert("Not saved", `The server answered ${res.status}.`); return; }
    refreshCast();
  }
  async function replaceStill(m: CastMember, files: FileList) {
    const f = files[0];
    if (!f) return;
    setBusy(true);
    try { const up = await uploadFile(f, "reference"); await patchCast(m, { uploadId: up.id }); }
    catch (e) { await appAlert("Could not replace the still", (e as Error).message); }
    finally { setBusy(false); }
  }
  async function editDescription(m: CastMember) {
    const d = await appPrompt(`Describe @${m.name} in a line`, m.description, "");
    if (d === null) return;
    await patchCast(m, { description: d });
  }
  async function removeCast(m: CastMember) {
    if (!(await appConfirm(`Remove @${m.name}?`, "Prompts that cite the name will stop resolving.", { confirmLabel: "Remove", danger: true }))) return;
    await fetch(`/api/cast/${m.id}`, { method: "DELETE" });
    setSel(null); refreshCast();
  }

  const openIdentity = openId === "new" ? null : identities.find((i) => i.id === openId) ?? null;
  const railName = curId ? curId.name : cur?.name ?? null;
  const railKind = curId ? "IDENTITY" : cur ? KINDS.find((k) => k.id === cur.kind)?.badge ?? "" : "";
  const railUpload = curId ? curId.coverUploadId : cur?.uploadId ?? null;
  /* The member's own view (brief 2.4): everything made with the name across
     the workspace's productions, asked of the server rather than sifted
     from one page of the current bin. The cards keep the bin's own count. */
  const { data: madeAll } = useApi<{ generations: Gen[] }>(signedIn && railName ? `/api/jobs?castName=${encodeURIComponent(railName)}&limit=500&sync=0` : null, 0);
  const railMade: Gen[] = madeAll?.generations ?? (railName ? madeWith(railName) : []);
  const railLine = railName ? usageLineOf(usageSummary(railMade)) : "";
  const railDesc = curId ? curId.description : cur?.description ?? "";
  const railWhat = curId ? "face" : cur?.kind === "location" ? "place" : cur?.kind === "prop" ? "object" : cur?.kind === "style" ? "look" : "face";

  return (
    <>
      <nav className="subnav !px-6" aria-label="Studio">
        <span className="subnav-item is-on" aria-current="page">Cast</span>
        <Link href="/studio/shot" className="subnav-item">Setup</Link>
        <span className="subnav-note">
          {scoped ? <>You&rsquo;re in <span className="text-ink">{current?.name ?? "this production"}</span> — cast added here stays with this production.</>
            : "All productions — cast added here is available everywhere."}
        </span>
      </nav>

      <div className="st" style={{ "--st-rail": `${railW}px` } as React.CSSProperties}>
        <section className="st-main">
          <div className="flex max-w-[760px] flex-col gap-2">
            <span className="mono !tracking-[.18em]">{scoped ? current?.name ?? "This production" : "The whole workspace"}</span>
            <p className="m-0 text-[18px] leading-[1.4] text-ink [text-wrap:pretty]">
              The hard part isn&rsquo;t making one good shot, it&rsquo;s making the second one match. Train a face from photos and it comes back as itself; name a face, a place or a prop once and it comes back exactly in every prompt afterwards.
            </p>
          </div>

          {/* ── Identities ─────────────────────────────────────── */}
          <div className="st-sec">
            <div className="st-sec-head">
              <span className="st-h">Trained identities</span>
              <span className="st-sub">a real face, learned from photos{!terms.configured && signedIn ? " · training runs on fal.ai, not connected yet" : ""}</span>
              <button type="button" className="btn-secondary ml-auto !min-h-[40px]" onClick={() => setOpenId("new")} disabled={!signedIn} title={signedIn ? undefined : "Sign in to train an identity"}>+ New identity</button>
            </div>
            <div className="idgrid">
              {identities.map((i) => (
                <button key={i.id} type="button" onClick={() => pick({ type: "identity", id: i.id })}
                  className={`idcard ${sel?.type === "identity" && sel.id === i.id ? "is-on" : ""}`}>
                  <span className="idcard-face">
                    {i.coverUploadId
                      ? /* eslint-disable-next-line @next/next/no-img-element */
                        <img src={`/api/uploads/${i.coverUploadId}`} alt="" loading="lazy" />
                      : <span className="mono-s">FACE · {i.name.toUpperCase()}</span>}
                  </span>
                  <span className="flex min-w-0 flex-col gap-1.5">
                    <span className="idcard-name">{i.name}</span>
                    <span className="idcard-state">
                      <span className={`dot ${i.status === "ready" ? "dot-approved" : i.status === "training" ? "dot-picked" : i.status === "failed" ? "dot-none" : "dot-draft"}`} />
                      {i.status === "ready" ? `Trained · ${i.photos.length} photos` : i.status === "training" ? `Training on ${terms.trainer || "fal.ai"}` : i.status === "failed" ? "Training failed" : `Not trained · ${i.photos.length} photo${i.photos.length === 1 ? "" : "s"}`}
                    </span>
                    {i.status === "training" && <span className="ptable-bar"><span style={{ width: "50%" }} /></span>}
                    <span className="idcard-line">
                      {i.status === "ready"
                        ? `Used in ${usageLine(i.name).toLowerCase()}. Stills carry the face itself; @${i.name} carries a still into video.`
                        : i.status === "training"
                          ? `${i.photos.length} photos · started ${timeAgo(i.updatedAt)}${i.authorName ? ` by ${i.authorName}` : ""}${i.costUsd != null ? ` · ${money.price(i.costUsd, "identity-training")} training cost` : terms.trainCostUsd ? ` · ~${money.price(terms.trainCostUsd, "identity-training")} training cost` : ""}`
                          : `${terms.recommended} photos of one person, then Train.`}
                    </span>
                  </span>
                </button>
              ))}
              <button type="button" className="idcard-add" onClick={() => setOpenId("new")} disabled={!signedIn}>
                <span className="text-[13px] font-medium text-ink">Add an identity</span>
                <span className="idcard-line">Ten to twenty photos of one person teach a small model that face. Gather the photos here; training runs when you press Train.</span>
              </button>
            </div>
          </div>

          {/* ── Cast and elements ──────────────────────────────── */}
          <div className="st-sec">
            <div className="st-sec-head">
              <span className="st-h">Cast</span>
              <span className="st-sub">A face, a place, a prop or a look, defined once. Open one to see everything made with it.</span>
            </div>
            <div className="seg self-start" role="tablist">
              {([["all", "All"], ...KINDS.map((k) => [k.id, k.label])] as [typeof filter, string][]).map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={filter === k} className={`seg-opt ${filter === k ? "is-on" : ""}`} onClick={() => setFilter(k)}>{label}</button>
              ))}
            </div>
            <div className="castgrid">
              {shownCast.map((m) => {
                const trained = identityFor(m.name)?.status === "ready";
                const on = (cur?.id === m.id) && !curId;
                return (
                  <button key={m.id} type="button" onClick={() => pick({ type: "cast", id: m.id })} className={`castcard ${on ? "is-on" : ""}`}
                    draggable onDragStart={(e) => startCastDrag(e, m)} title={`Drag @${m.name} into a prompt`}>
                    <span className="castcard-still">
                      {m.uploadId && /* eslint-disable-next-line @next/next/no-img-element */
                        <img src={`/api/uploads/${m.uploadId}`} alt="" loading="lazy" />}
                      <span className="well-badge tl !tracking-[.08em]">{KINDS.find((k) => k.id === m.kind)?.badge}</span>
                      {trained && <span className="well-badge tr flex items-center gap-1.5"><span className="dot dot-approved !h-1.5 !w-1.5" />IDENTITY</span>}
                    </span>
                    <span className="castcard-body">
                      <span className="castcard-name">@{m.name}</span>
                      <span className="castcard-desc">{m.description || "—"}</span>
                      <span className="mono-s mt-0.5">{usageLine(m.name)}</span>
                    </span>
                  </button>
                );
              })}
              <div className="relative">
                <button type="button" className="castcard-add" onClick={() => setAdding((v) => !v)} disabled={!signedIn || busy}>
                  <span className="text-[13px] font-medium text-ink">+ Add to cast</span>
                  <span className="idcard-line text-center">A still and a line of description, then write @TheirName in any prompt.</span>
                </button>
                {adding && (
                  <div role="menu" className="menu-pop absolute left-4 top-12 z-30 min-w-[200px]">
                    {KINDS.map((k) => (
                      <button key={k.id} type="button" role="menuitem" className="menu-item" title={k.blurb}
                        onClick={() => { setAdding(false); setPendingKind(k.id); file.current?.click(); }}>{k.label}</button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {!signedIn && <Empty compact title="Cast is for the team" line="Sign in to see who this production keeps returning to." />}
          </div>
          <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { if (e.target.files) addFrom(e.target.files); e.target.value = ""; }} />
          <input ref={replaceFile} type="file" accept="image/*" hidden onChange={(e) => { if (e.target.files && cur) replaceStill(cur, e.target.files); e.target.value = ""; }} />
          <RulesSection signedIn={signedIn} />

        </section>

        {/* ── Detail rail ───────────────────────────────────────── */}
        {mobile && sheetOpen && <div className="sheet-scrim" onClick={() => setSheetOpen(false)} />}
        <aside className={`ws-rail ${mobile ? (sheetOpen ? "is-sheet" : "is-hidden") : ""}`}>
          <PaneDivider spec={PANES.studio} label="Studio rail" />
          <div className="sheet-grab" aria-hidden="true"><span /></div>
          <div className="ws-rail-head">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="ws-bar-h truncate">{railName ? (curId ? railName : `@${railName}`) : "Nothing selected"}</span>
              <span className="mono !tracking-[.08em]">{railKind}</span>
            </span>
            {railName && <span className="mono-s">{railLine}</span>}
            {mobile && <button type="button" className="btn-secondary !h-8 !px-2.5 !text-[12px] ml-auto" onClick={() => setSheetOpen(false)}>Close</button>}
          </div>
          <div className="ws-rail-body !gap-4">
            <div className="st-still">
              {railUpload
                ? /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={`/api/uploads/${railUpload}`} alt="" />
                : <span className="mono-s">{railName ? `${curId ? "FACE" : "STILL"} · ${railName.toUpperCase()}` : "PICK A CARD"}</span>}
            </div>
            {railName && <p className="m-0 text-[13.5px] leading-[1.5] text-ink [text-wrap:pretty]">{railDesc || "No description yet."}</p>}
            {cur && !curId && (
              <div className="flex gap-1.5">
                <button type="button" className="trk-btn flex-1 !py-2" onClick={() => replaceFile.current?.click()} disabled={busy}>Replace still</button>
                <button type="button" className="trk-btn flex-1 !py-2" onClick={() => editDescription(cur)}>Edit description</button>
                {identityFor(cur.name) && <button type="button" className="trk-btn flex-1 !py-2" onClick={() => setOpenId(identityFor(cur.name)!.id)}>Retrain</button>}
                <button type="button" className="trk-btn !py-2 text-lift" onClick={() => removeCast(cur)} title="Remove from the cast">Remove</button>
              </div>
            )}
            {curId && (
              <div className="flex gap-1.5">
                <button type="button" className="trk-btn flex-1 !py-2" onClick={() => setOpenId(curId.id)}>{curId.status === "ready" ? "Retrain" : curId.status === "training" ? "Watch training" : "Photos & train"}</button>
              </div>
            )}
            {railName && (
              <>
                <div className="ws-block !pt-3.5">
                  <span className="mono">Everything made with @{railName}</span>
                  {railMade.length ? (
                    <div className="grid grid-cols-3 gap-1.5">
                      {railMade.slice(0, 12).map((g) => (
                        <Link key={g.id} href={g.kind === "image" ? "/images" : g.kind === "audio" ? "/audio" : "/"} className="st-take">
                          <span className="st-take-well">
                            {g.storedUrl && g.status === "succeeded" && g.kind !== "audio"
                              ? <LazyMedia url={g.storedUrl} kind={g.kind === "image" ? "image" : "video"} alt="" className="!absolute inset-0" />
                              : null}
                          </span>
                          <span className="st-take-cap"><span>{g.shotCode ?? "—"}</span><span className="text-dim">{g.kind === "image" ? `S${g.version ?? 1}` : `v${g.version ?? 1}`}</span></span>
                        </Link>
                      ))}
                    </div>
                  ) : <span className="rail-help">Nothing yet — the first render that cites @{railName} lands here.</span>}
                </div>
                <div className="ws-block !pt-3.5">
                  <span className="mono">In the prompt</span>
                  <div className="st-explain">
                    Write <span className="island-cite !rounded-[4px] !px-1 font-medium text-ink">@{railName}</span> anywhere. The composer swaps in the still and the description, so the same {railWhat} comes back in every shot.
                  </div>
                </div>
              </>
            )}
          </div>
        </aside>
      </div>

      {openId && (
        <IdentitySheet key={openId} identity={openIdentity} projectId={scoped ? bin : null} terms={terms}
          onClose={() => setOpenId(null)} onChanged={() => { refreshIds(); refreshCast(); }} />
      )}
      {busy && (
        <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-[7px] border border-line bg-panel px-4 py-2 text-[13px]">
          <ParticlSpinner size={14} className="mr-2 inline-block align-middle text-dim" /> Working…
        </div>
      )}
    </>
  );
}
