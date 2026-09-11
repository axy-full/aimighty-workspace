"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useProject } from "@/lib/projectContext";
import { usePageTitle } from "@/lib/usePageTitle";
import { useAtomikRail } from "@/lib/atomikRail";
import { uploadFile } from "@/lib/uploadClient";
import { ELEMENT_KINDS, type ElementKind } from "@/lib/rig";
import type { ElementFull } from "@/lib/elements";
import type { ProductionRow } from "@/lib/productions";
import type { Generation } from "@/lib/jobs";
import { Button, Chip, Mono, PinnedBar, PinnedPrimary } from "@/components/ui";
import { usePhone } from "@/lib/usePhone";
import { useMoney } from "@/lib/price";
import Menu, { type MenuItem } from "@/components/ui/Menu";
import { contextItems, ContextMenuHost } from "@/components/ui/ContextMenu";
import Pressable from "@/components/ui/Pressable";
import { getClip, setClip, useClipboard } from "@/lib/clipboard";
import { scheduleDelete, cancelDelete } from "@/lib/undoDelete";
import { appPrompt } from "@/components/dialog";
import { ToastHost, useToast } from "@/components/ui/Toast";
import { PageLoader } from "@/components/atomik/Loader";
import UnfiledWall from "@/components/make/UnfiledWall";
import NewAssetSheet, { type SheetRef } from "@/components/assets/NewAssetSheet";

/**
 * Library (design/particl-v2/README.md §11, board 8b; restructured by
 * docs/change-request-1.md §5): one collection under labelled sections —
 * Characters · Locations · Props · Looks · Voices · References · Unfiled —
 * each a titled grid with its own count and `+ New`. A 240px index on the
 * left (desktop) follows the scroll and jumps to a label; on a phone the
 * same index is a row of pills. It indexes project media; it never stores
 * a second copy.
 *
 * Every asset card: the canonical still, the kind, the lock, how many
 * versions, `@Name`, and where it is used (`6 shots · 2 productions`, from
 * the bindings). On hover, three actions — `Use in Make`, `Add to Canvas`,
 * `Open`; on a phone the same three sit under the long-press menu. The
 * `+ New` under a label opens New asset with that kind picked (the maker of
 * CR1 §1 will take its place). References keep their own three — Promote ·
 * Use in Make · Add to Canvas. Filters: production, locked, trained;
 * search by name and `@Name`. Empty labels say one line and offer `+ New`,
 * nothing else; a new workspace's starter cast is already here.
 *
 * The 52px header (`0 24px`, 14 apart, a .06 rule): `Library` at 600 16
 * over `12 ASSETS · 38 REFERENCES · 9 UNFILED TAKES · ALL PRODUCTIONS`,
 * the filters (`8px 11px`, .12), the 240px search, and the one filled
 * primary, `New asset · 0 CR` (38px, `0 16px`). Cards keep 8b's numbers:
 * radius 12 on `--card` (`--card-raised` when locked), the 4:3 still, the
 * chips at 8/8, the name at 600 13.5, the line under it at 400 12.
 *
 * Below 768 (design/particl-v2-mobile, board M7): `16px 16px`, 12 apart —
 * `Library` at 600 24/1.05 −0.02em over the counts, the index pills
 * scrolling edge to edge (`Filter ▾`, `⌕ Search`, then the seven labels
 * with their counts), the sections two-up (radius 12; chips at 7/7; the
 * name at 600 13.5; the where-used in mono). `New asset · 0 CR` pinned.
 *
 * CR1 §10: right-click (long-press) on an asset or a reference opens the
 * one context menu. CR1 §11: files dropped on a label become the
 * references of a new asset of that kind; on References they land as
 * references.
 */
type Upload = { id: string; filename: string; mime: string; bytes: number; width: number | null; height: number | null; kind: "image" | "video"; durationS: number | null; url: string; createdAt: number };
const KIND_WORD: Record<ElementKind, string> = { character: "Character", location: "Location", prop: "Prop", look: "Look", voice: "Voice" };
const LABEL: Record<ElementKind, string> = { character: "Characters", location: "Locations", prop: "Props", look: "Looks", voice: "Voices" };
type SectionId = ElementKind | "references" | "unfiled";
const SECTIONS: { id: SectionId; label: string }[] = [
  ...ELEMENT_KINDS.map((k) => ({ id: k as SectionId, label: LABEL[k] })),
  { id: "references", label: "References" },
  { id: "unfiled", label: "Unfiled" },
];
const isKind = (id: SectionId): id is ElementKind => (ELEMENT_KINDS as readonly string[]).includes(id);
type Row = { label: string; note?: string; onSelect: () => void };

export default function LibraryPage() {
  return <ToastHost><Library /></ToastHost>;
}

function Library() {
  const router = useRouter();
  const search = useSearchParams();
  const { signedIn } = useSession();
  const { current } = useProject();
  const toast = useToast();
  const rail = useAtomikRail();
  const phone = usePhone();
  const money = useMoney();
  const clip = useClipboard();
  usePageTitle("Library");

  const [q, setQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [production, setProduction] = useState<string | null>(null);
  const [locked, setLocked] = useState<boolean | null>(null);
  const [trained, setTrained] = useState<boolean | null>(null);
  const [menu, setMenu] = useState<{ which: "production" | "locked" | "trained" | "filters"; x: number; y: number; sub: string | null } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [refMenu, setRefMenu] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ refs: SheetRef[]; name?: string; kind?: ElementKind } | null>(null);
  const [card, setCard] = useState<{ x: number; y: number; kind: "asset" | "reference"; id: string; sub: "move" | "share" | null } | null>(null);
  const [hiddenRefs, setHiddenRefs] = useState<Set<string>>(new Set());
  const [currentId, setCurrentId] = useState<SectionId>("character");
  const [flash, setFlash] = useState<string | null>(null);

  const { data: els, refresh: refreshEls } = useApi<{ elements: ElementFull[] }>(signedIn ? "/api/rig/elements?usage=1" : null, 30_000);
  const { data: ups, refresh: refreshUps } = useApi<{ uploads: Upload[] }>(signedIn ? "/api/uploads?limit=300" : null, 30_000);
  const { data: prods } = useApi<{ productions: ProductionRow[] }>(signedIn ? "/api/productions" : null, 60_000);
  const { data: unfiled } = useApi<{ generations: Generation[] }>(signedIn ? "/api/jobs?unfiled=1&limit=200&sync=0" : null, 30_000);

  const productionOf = (projectId: string | null) => projectId ? prods?.productions.find((p) => p.projects.some((j) => j.id === projectId)) ?? null : null;
  const trainedOf = (a: ElementFull) => a.attributes.some((at) => at.versions.some((v) => v.identityId && v.status === "ready"));
  const needle = q.trim().toLowerCase();
  const assets = useMemo(() => (els?.elements ?? []).filter((e) =>
    (!production || productionOf(e.projectId)?.id === production) && (locked == null || e.locked === locked) && (trained == null || trainedOf(e) === trained)
    && (!needle || `${e.name} @${e.name} ${e.kind} ${e.description}`.toLowerCase().includes(needle))), [els, production, locked, trained, needle, prods]);   // eslint-disable-line react-hooks/exhaustive-deps
  const byKind = useMemo(() => { const m = new Map<ElementKind, ElementFull[]>(); for (const k of ELEMENT_KINDS) m.set(k, []); for (const a of assets) m.get(a.kind)?.push(a); return m; }, [assets]);
  const refs = useMemo(() => (ups?.uploads ?? []).filter((u) => !hiddenRefs.has(u.id) && (!needle || u.filename.toLowerCase().includes(needle))), [ups, needle, hiddenRefs]);
  const sel = refs.find((u) => u.id === selected) ?? null;
  const counts = { assets: els?.elements.length ?? 0, refs: ups?.uploads.length ?? 0, unfiled: unfiled?.generations.length ?? 0 };
  const countOf = (id: SectionId) => isKind(id) ? (byKind.get(id)?.length ?? 0) : id === "references" ? refs.length : counts.unfiled;
  const picker = useRef<HTMLInputElement>(null);
  const addReferences = () => picker.current?.click();
  const column = useRef<HTMLDivElement>(null);
  const ready = Boolean(els && ups && prods);

  /* ── the index follows the scroll; a label jumps to its section ──────── */
  const hold = useRef(0);
  const jump = (id: SectionId) => { hold.current = Date.now() + 500; document.getElementById(`lib-${id}`)?.scrollIntoView({ block: "start" }); setCurrentId(id); };
  useEffect(() => {
    if (!ready) return;
    const el = column.current; if (!el) return;
    const onScroll = () => {
      if (Date.now() < hold.current) return;   // a jump's own scroll must not re-aim the index
      const line = el.getBoundingClientRect().top + 40;
      /* The last section whose top is above the line; at the bottom of the column, the last section — so a short tail can be current. */
      let best: SectionId = SECTIONS[0].id;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) best = SECTIONS[SECTIONS.length - 1].id;
      else for (const s of SECTIONS) { const n = document.getElementById(`lib-${s.id}`); if (n && n.getBoundingClientRect().top <= line) best = s.id; }
      setCurrentId(best);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [ready, phone]);
  /* The ring on a shared-link or just-made card fades after a moment. */
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 2500); return () => clearTimeout(t); }, [flash]);
  /* `?view=unfiled|references` (the old lenses, still linked), `#label`, and `?asset=` from a shared link. */
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !ready || !els) return;
    landed.current = true;
    const view = search.get("view"); const hash = typeof window !== "undefined" ? window.location.hash.slice(1) : "";
    const asset = search.get("asset");
    const want = (view === "unfiled" || view === "references" ? view : SECTIONS.some((s) => s.id === hash) ? (hash as SectionId) : null);
    if (asset) { const a = els.elements.find((e) => e.id === asset); if (a) { setTimeout(() => { setFlash(a.id); document.getElementById(`asset-${a.id}`)?.scrollIntoView({ block: "center" }); }, 0); return; } }
    if (want) setTimeout(() => jump(want), 0);
  }, [ready, els, search]);

  /* ── files and references ────────────────────────────────────────────── */
  const drop = async (files: FileList) => {
    const list = Array.from(files).slice(0, 12);
    try { for (const f of list) await uploadFile(f, "reference"); toast(`${list.length} ${list.length === 1 ? "reference" : "references"} on the board`); refreshUps(); }
    catch (e) { toast((e as Error).message); }
  };
  /* CR1 §11: files dropped on a label become the references of a new asset of that kind. */
  const dropOnKind = async (files: FileList, kind: ElementKind) => {
    const list = Array.from(files).slice(0, 12);
    if (!list.length) return;
    try {
      const made: SheetRef[] = [];
      for (const f of list) { const up = await uploadFile(f, "reference"); made.push({ uploadId: up.id, url: up.url, label: up.filename, kind: up.kind === "video" ? "video" : "image" }); }
      refreshUps(); setSheet({ refs: made, kind });
    } catch (e) { toast((e as Error).message); }
  };
  const promoteName = (u: Upload) => u.filename.replace(/\.[a-z0-9]+$/i, "").replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() + w.slice(1)).join("");
  const promote = (u: Upload) => setSheet({ refs: [{ uploadId: u.id, url: u.url, label: u.filename, kind: u.kind }], name: promoteName(u) });
  const sendRefToMake = (u: Upload) => router.push(`/make/${u.kind === "video" ? "video" : "images"}?ref=${encodeURIComponent(u.id)}`);
  const refToCanvas = (u: Upload) => current ? router.push(`/rig/canvas/new?project=${encodeURIComponent(current.id)}&ref=${encodeURIComponent(u.id)}`) : toast("Pick a production first — Canvas belongs to a project.");

  /* ── the three actions on an asset (CR1 §5) ──────────────────────────── */
  const stillOf = (a: ElementFull) => { const first = a.attributes[0]; const cur = first?.versions.find((v) => v.id === first.currentId) ?? first?.versions[0] ?? null; return cur?.uploadId ? cur.uploadId : null; };
  const sendToMake = (a: ElementFull) => {
    const still = stillOf(a);
    if (still) router.push(`/make/images?ref=${encodeURIComponent(still)}`);
    else { router.push(a.kind === "voice" ? "/make/audio" : "/make/video"); toast(`Type @${a.name} in the prompt to bind it — it has no still to carry yet.`); }
  };
  const addToCanvas = (a: ElementFull) => {
    const project = a.projectId ?? current?.id ?? null;
    if (!project) { toast("Pick a production first — Canvas belongs to a project."); return; }
    router.push(`/rig/canvas/new?project=${encodeURIComponent(project)}&asset=${encodeURIComponent(a.id)}`);
  };
  const openAsset = (a: ElementFull) => router.push(`/elements/${encodeURIComponent(a.id)}`);

  /* ── filters ─────────────────────────────────────────────────────────── */
  const at = (e: React.MouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return { x: r.left, y: r.bottom + 6 }; };
  const productionRows = (): Row[] => [
    { label: "Any", onSelect: () => { setProduction(null); setMenu(null); } },
    ...(prods?.productions ?? []).map((p) => ({ label: p.name, onSelect: () => { setProduction(p.id); setMenu(null); } })),
  ];
  const lockedRows = (): Row[] => [
    { label: "Any", onSelect: () => { setLocked(null); setMenu(null); } },
    { label: "Locked", onSelect: () => { setLocked(true); setMenu(null); } },
    { label: "Open", onSelect: () => { setLocked(false); setMenu(null); } },
  ];
  const trainedRows = (): Row[] => [
    { label: "Any", onSelect: () => { setTrained(null); setMenu(null); } },
    { label: "Trained", note: "a face ready", onSelect: () => { setTrained(true); setMenu(null); } },
    { label: "Not trained", onSelect: () => { setTrained(false); setMenu(null); } },
  ];
  const asItems = (rows: Row[]): MenuItem[] => rows.map((r) => ({ kind: "item", label: r.label, keys: r.note, onSelect: r.onSelect }));
  const subOf = (key: string, label: string, rows: Row[]): MenuItem => ({ kind: "sub", label, open: menu?.sub === key, onToggle: () => setMenu((m) => m && { ...m, sub: m.sub === key ? null : key }), items: rows });
  const menuItems: MenuItem[] = !menu ? [] : menu.which === "production" ? asItems(productionRows()) : menu.which === "locked" ? asItems(lockedRows()) : menu.which === "trained" ? asItems(trainedRows()) : [
    subOf("production", `Production${production ? ` · ${prods?.productions.find((p) => p.id === production)?.name ?? ""}` : ""}`, productionRows()),
    subOf("locked", `Locked${locked == null ? "" : locked ? " · locked" : " · open"}`, lockedRows()),
    subOf("trained", `Trained${trained == null ? "" : trained ? " · trained" : " · not trained"}`, trainedRows()),
  ];
  const filtering = production != null || locked != null || trained != null;

  /* ── CR1 §10: the menu's verbs on an asset and on a reference ─────────── */
  const putAsset = (id: string, body: Record<string, unknown>) => fetch(`/api/rig/elements/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const cloneAsset = async (id: string, said: string) => {
    setCard(null);
    const r = await fetch("/api/rig/elements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cloneOf: id }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error ?? "Not duplicated."); return; }
    refreshEls(); toast(`@${j.element?.name ?? "copy"} · ${said}`);
  };
  const toggleSub = (which: "move" | "share") => setCard((m) => m && { ...m, sub: m.sub === which ? null : which });
  const assetActions = (a: ElementFull): MenuItem[] => [
    ...contextItems({
      cut: () => { setClip({ kind: "asset", mode: "cut", id: a.id, label: `@${a.name}` }); setCard(null); toast(`@${a.name} cut · paste it under a production to move it there`); },
      copy: () => { setClip({ kind: "asset", mode: "copy", id: a.id, label: `@${a.name}` }); setCard(null); toast(`@${a.name} copied · paste makes a new asset with nothing trained`); },
      paste: clip?.kind === "asset" ? () => { const c = getClip()!; if (c.mode === "copy") cloneAsset(c.id, "pasted as a new asset, nothing trained"); else { setCard(null); toast("A cut asset moves with Move to ▸ — pick the production there."); } } : null,
      duplicate: () => cloneAsset(a.id, "a copy, nothing trained"),
      rename: async () => { setCard(null); const v = await appPrompt("Rename the asset", a.name, "Name"); if (!v?.trim()) return; const r = await putAsset(a.id, { name: v.trim() }); if (!r.ok) { toast("That didn't stick."); return; } refreshEls(); toast(`Now @${v.trim().replace(/\s+/g, "")}`); },
      moveTo: { open: card?.sub === "move", onToggle: () => toggleSub("move"), items: [
        { label: "All productions", note: "shared", onSelect: async () => { setCard(null); await putAsset(a.id, { projectId: null }); refreshEls(); toast(`@${a.name} · every production`); } },
        ...(prods?.productions ?? []).flatMap((p) => p.projects.map((j) => ({ label: p.projects.length > 1 ? `${p.name} › ${j.name}` : p.name, onSelect: async () => { setCard(null); await putAsset(a.id, { projectId: j.id }); refreshEls(); toast(`@${a.name} moved to ${p.name}`); } }))),
      ] },
      share: { open: card?.sub === "share", onToggle: () => toggleSub("share"), copyLink: () => { setCard(null); navigator.clipboard?.writeText(`${location.origin}/library?asset=${encodeURIComponent(a.id)}`).then(() => toast(`Link to @${a.name} copied · opens for this workspace`)); } },
      download: stillOf(a) ? () => { setCard(null); window.open(`/api/uploads/${encodeURIComponent(stillOf(a)!)}`, "_blank", "noopener"); } : undefined,
      openInRig: a.projectId || current ? () => { setCard(null); addToCanvas(a); } : undefined,
      remove: async () => {
        setCard(null);
        const r = await fetch(`/api/rig/elements/${a.id}`, { method: "DELETE" });
        if (!r.ok) { toast("Not deleted."); return; }
        refreshEls();
        toast(`@${a.name} deleted`, async () => { await putAsset(a.id, { restore: true }); refreshEls(); });
      },
      note: a.locked ? "Locked: it stays bound where it is used; unlock before changing what it binds." : undefined,
    }),
    { kind: "divider" },
    { kind: "item", label: "Use in Make", onSelect: () => { setCard(null); sendToMake(a); } },
    { kind: "item", label: "Add to Canvas", onSelect: () => { setCard(null); addToCanvas(a); } },
    { kind: "item", label: "Open", onSelect: () => { setCard(null); openAsset(a); } },
  ];
  const referenceActions = (u: Upload): MenuItem[] => [
    ...contextItems({
      copy: () => { setClip({ kind: "reference", mode: "copy", id: u.id, label: u.filename, payload: { url: u.url, kind: u.kind } }); setCard(null); toast(`${u.filename} copied · paste it into the composer's well`); },
      rename: async () => { setCard(null); const v = await appPrompt("Rename the reference", u.filename, "Name"); if (!v?.trim()) return; const r = await fetch(`/api/uploads/${u.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: v.trim() }) }); if (!r.ok) { toast("That didn't stick."); return; } refreshUps(); toast(`Now ${v.trim()}`); },
      share: { open: card?.sub === "share", onToggle: () => toggleSub("share"), copyLink: () => { setCard(null); navigator.clipboard?.writeText(`${location.origin}/api/uploads/${encodeURIComponent(u.id)}`).then(() => toast("Link copied · opens for this workspace")); } },
      download: () => { setCard(null); window.open(`/api/uploads/${encodeURIComponent(u.id)}`, "_blank", "noopener"); },
      openInRig: current ? () => { setCard(null); refToCanvas(u); } : undefined,
      remove: () => {
        setCard(null); setSelected(null);
        setHiddenRefs((h) => new Set(h).add(u.id));
        scheduleDelete(u.id, async () => { await fetch(`/api/uploads/${u.id}`, { method: "DELETE" }); refreshUps(); });
        toast(`${u.filename} deleted`, () => { cancelDelete(u.id); setHiddenRefs((h) => { const n = new Set(h); n.delete(u.id); return n; }); });
      },
    }),
    { kind: "divider" },
    { kind: "item", label: "Promote to asset", keys: "0 cr", onSelect: () => { setCard(null); promote(u); } },
    { kind: "item", label: "Use in Make", onSelect: () => sendRefToMake(u) },
    { kind: "item", label: "Add to Canvas", onSelect: () => refToCanvas(u) },
  ];
  const cardAsset = card?.kind === "asset" ? (els?.elements ?? []).find((a) => a.id === card.id) ?? null : null;
  const cardRef = card?.kind === "reference" ? (ups?.uploads ?? []).find((u) => u.id === card.id) ?? null : null;
  const cardItems: MenuItem[] = cardAsset ? assetActions(cardAsset) : cardRef ? referenceActions(cardRef) : [];
  const cardTitle = cardAsset ? `@${cardAsset.name} · ${KIND_WORD[cardAsset.kind].toLowerCase()}` : cardRef ? `Ref · ${cardRef.filename.slice(0, 24)}` : "";
  const refSel = refs.find((u) => u.id === refMenu) ?? null;
  const refItems: MenuItem[] = refSel ? [
    { kind: "item", label: "Promote to asset", keys: money.price(0), onSelect: () => { setRefMenu(null); promote(refSel); } },
    { kind: "item", label: "Use in Make", onSelect: () => sendRefToMake(refSel) },
    { kind: "item", label: "Add to Canvas", onSelect: () => refToCanvas(refSel) },
    { kind: "note", text: "References are free and unversioned until promoted." },
  ] : [];

  if (!signedIn) return <div className="p-[24px] text-[13px] text-ink-body">Sign in to open the Library.</div>;
  if (!els || !ups || !prods) return <PageLoader what="Opening · Library" />;

  /* ── the pieces both layouts share ───────────────────────────────────── */
  const cols = phone ? "grid-cols-2" : rail.state === "expanded" ? "grid-cols-2" : rail.state === "compact" ? "grid-cols-3" : "grid-cols-4 max-lg:grid-cols-3";
  const refCols = phone ? "grid-cols-2" : rail.state === "expanded" ? "grid-cols-3" : rail.state === "compact" ? "grid-cols-4" : "grid-cols-6 max-lg:grid-cols-4";
  const pill = (on: boolean) => `tap44 flex flex-none items-center gap-[6px] rounded-pill border border-[rgba(245,246,248,.12)] px-[11px] py-[8px] text-[12.5px] font-medium leading-none ${on ? "bg-[rgba(245,246,248,.1)] text-ink" : "text-ink-body"}`;
  const filter = "tap44 flex items-center gap-[5px] rounded-pill border border-[rgba(245,246,248,.12)] px-[11px] py-[8px] text-[12.5px] font-medium leading-none text-ink";
  const act = "flex h-[26px] items-center rounded-pill border border-border-mid bg-ground px-[8px] text-[12px] font-medium leading-none text-ink hover:border-border-hover";
  const usedLine = (a: ElementFull) => {
    const u = a.usage;
    if (!u || !u.shots) return "not in a shot yet";
    return `${u.shots} ${u.shots === 1 ? "shot" : "shots"} · ${u.productions} ${u.productions === 1 ? "production" : "productions"}`;
  };
  const assetCard = (a: ElementFull) => {
    const first = a.attributes[0];
    const cur = first?.versions.find((v) => v.id === first.currentId) ?? first?.versions[0] ?? null;
    const versions = first?.versions.length ?? 0;
    const on = flash === a.id;
    const off = phone ? "7px" : "8px";
    return (
      <Pressable as="article" key={a.id} id={`asset-${a.id}`} aria-current={on ? "true" : undefined} onMenu={(x, y) => setCard({ x, y, kind: "asset", id: a.id, sub: null })}
        className={`group flex flex-col overflow-hidden rounded-card border ${on ? "border-ink shadow-[0_0_0_3px_rgba(245,246,248,.12)]" : phone ? "border-border" : "border-[rgba(245,246,248,.1)] hover:border-border-hover"} ${a.locked ? "bg-card-raised" : "bg-card"}`}
        aria-label={`${KIND_WORD[a.kind]} @${a.name}`} data-asset={a.id}>
        <span className="relative block aspect-[4/3] border-b border-hairline ui-placeholder">
          {cur?.uploadId && <img src={`/api/uploads/${encodeURIComponent(cur.uploadId)}`} alt="" className="absolute inset-0 h-full w-full object-cover" />}
          <span className="ui-chip-scrim absolute rounded-badge px-[6px] py-[4px]" style={{ left: off, top: off }}><span className="ui-mono text-ink">{a.kind}</span></span>
          {a.locked && <span className="ui-chip-scrim absolute flex h-[24px] w-[24px] items-center justify-center rounded-[6px]" style={{ right: off, top: off }} title={`Locked${a.lockedBy ? ` by ${a.lockedBy}` : ""}`}><svg viewBox="0 0 12 12" width="11" height="11" style={{ fill: "none", stroke: "var(--ink)", strokeWidth: 1.3 }} aria-hidden="true"><rect x="2" y="5.4" width="8" height="5.4" rx="1.2" /><path d="M4 5.4V4a2 2 0 0 1 4 0v1.4" /></svg></span>}
          <span className={`ui-chip-scrim absolute rounded-badge px-[6px] py-[4px] ${phone ? "" : "group-hover:invisible group-focus-within:invisible"}`} style={{ right: off, bottom: off }}><span className="ui-mono tracking-normal text-ink-body">{versions} {versions === 1 ? "version" : "versions"}</span></span>
          {!phone && (
            <span className="invisible absolute inset-x-[8px] bottom-[8px] z-[2] flex gap-[4px] opacity-0 transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100" data-actions="">
              <button type="button" className={act} onClick={(e) => { e.stopPropagation(); sendToMake(a); }}>Use in Make</button>
              <button type="button" className={act} onClick={(e) => { e.stopPropagation(); addToCanvas(a); }}>Add to Canvas</button>
              <button type="button" className={`${act} ml-auto`} onClick={(e) => { e.stopPropagation(); openAsset(a); }}>Open</button>
            </span>
          )}
        </span>
        <span className={`flex flex-col gap-[5px] ${phone ? "px-[10px] pb-[10px] pt-[9px]" : "px-[11px] pb-[11px] pt-[9px]"}`}>
          <span className="truncate text-[13.5px] font-semibold leading-[1.2] text-ink">@{a.name}</span>
          {phone ? <Mono cost className="truncate">{usedLine(a)}</Mono> : <span className="truncate text-[12px] leading-[1.3] text-ink-body">{usedLine(a)}</span>}
        </span>
      </Pressable>
    );
  };
  const head = (id: SectionId, meta: string, add?: React.ReactNode) => (
    <div className="flex min-w-0 items-baseline gap-[10px] max-md:gap-[8px]">
      <h2 id={`lib-${id}-title`} className="flex-none text-[14px] font-semibold leading-none text-ink">{SECTIONS.find((s) => s.id === id)!.label}</h2>
      <span className="min-w-0 truncate text-[12.5px] leading-none text-ink-body max-md:ml-auto max-md:text-[12px]">{meta}</span>
      <span className="h-px flex-1 self-center bg-[rgba(245,246,248,.07)] max-md:hidden" />
      {add && <span className="flex-none">{add}</span>}
    </div>
  );
  const kindSection = (k: ElementKind) => {
    const rows = byKind.get(k) ?? [];
    const one = KIND_WORD[k];
    return (
      <section key={k} id={`lib-${k}`} aria-label={LABEL[k]} className="flex scroll-mt-[8px] flex-col gap-[10px] max-md:gap-[8px]"
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); dropOnKind(e.dataTransfer.files, k); } }}>
        {head(k, rows.length
          ? (phone ? `${rows.length}${rows.some(trainedOf) ? ` · ${rows.filter(trainedOf).length} trained` : ""}` : `${rows.length} · ${rows.filter(trainedOf).length} trained · drop files for a new ${one.toLowerCase()}`)
          : filtering || needle ? "none match" : phone ? "none yet" : "none yet · creating is free", <Chip variant="dashed" onClick={() => setSheet({ refs: [], kind: k })}>+ {one}</Chip>)}
        {rows.length > 0 && <div className={`grid gap-[10px] ${cols}`} data-assets={k}>{rows.map(assetCard)}</div>}
      </section>
    );
  };
  const referencesSection = (
    <section id="lib-references" aria-label="References" className="flex scroll-mt-[8px] flex-col gap-[10px] max-md:gap-[8px]"
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); drop(e.dataTransfer.files); } }}
      onPointerDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
      <input ref={picker} type="file" accept="image/*,video/*" multiple hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { if (e.target.files) drop(e.target.files); e.target.value = ""; }} />
      {head("references", refs.length ? (phone ? `${refs.length}` : `${refs.length} · free until promoted · drop anything`) : needle ? "none match" : phone ? "none yet" : "none yet · drop images or clips · free until promoted", <Chip variant="dashed" onClick={addReferences}>+ Add references</Chip>)}
      {sel && !phone && (
        <span className="flex flex-wrap gap-[6px]" data-reference-actions="">
          <button type="button" onClick={() => promote(sel)} className="tap44 flex h-[34px] items-center gap-[8px] rounded-pill border border-[rgba(245,246,248,.3)] bg-ground px-[12px] text-[12.5px] font-medium leading-none text-ink">Promote to asset<Mono cost>0 cr</Mono></button>
          <button type="button" onClick={() => sendRefToMake(sel)} className="tap44 flex h-[34px] items-center rounded-pill border border-border-mid bg-ground px-[12px] text-[12.5px] font-medium leading-none text-ink">Use in Make</button>
          <button type="button" onClick={() => refToCanvas(sel)} className="tap44 flex h-[34px] items-center rounded-pill border border-border-mid bg-ground px-[12px] text-[12.5px] font-medium leading-none text-ink-body">Add to Canvas</button>
        </span>
      )}
      {refs.length > 0 && (
        <div className={`grid gap-[10px] ${refCols}`} data-references="">
          {refs.map((u) => {
            const on = selected === u.id;
            return (
              <Pressable as="button" key={u.id} type="button" onMenu={(x, y) => { setSelected(u.id); setCard({ x, y, kind: "reference", id: u.id, sub: null }); }}
                onClick={(e) => { e.stopPropagation(); if (phone) setRefMenu(u.id); else setSelected(on ? null : u.id); }} aria-label={`Reference · ${u.filename}`} aria-pressed={phone ? undefined : on}
                className={`relative box-border aspect-[4/3] overflow-hidden rounded-tile border text-left ui-placeholder ${on ? "border-ink shadow-[0_0_0_3px_rgba(245,246,248,.1)]" : "border-[rgba(245,246,248,.1)]"}`}>
                {u.kind === "image" && <img src={u.url} alt="" className="absolute inset-0 h-full w-full object-cover" />}
                <span className="ui-chip-scrim absolute bottom-[6px] left-[6px] max-w-[calc(100%-12px)] truncate rounded-badge px-[6px] py-[4px]"><span className="ui-mono text-ink">Ref · {u.filename.replace(/\.[a-z0-9]+$/i, "").slice(0, 18)}</span></span>
              </Pressable>
            );
          })}
        </div>
      )}
    </section>
  );
  const unfiledSection = (
    <section id="lib-unfiled" aria-label="Unfiled" className="flex scroll-mt-[8px] flex-col gap-[10px] max-md:gap-[8px]">
      {head("unfiled", counts.unfiled ? (phone ? `${counts.unfiled}` : `${counts.unfiled} ${counts.unfiled === 1 ? "take" : "takes"} · from Make, not filed to a shot`) : phone ? "none" : "none · everything made in Make lands here")}
      <UnfiledWall kind="all" search={q} phone={phone} columns={cols} />
    </section>
  );
  const sections = (
    <>
      {ELEMENT_KINDS.map(kindSection)}
      {referencesSection}
      {unfiledSection}
    </>
  );
  const overlays = (
    <>
      {menu && <Menu x={menu.x} y={menu.y} title={menu.which === "production" ? "Production" : menu.which === "locked" ? "Locked" : menu.which === "trained" ? "Trained" : "Filter"} items={menuItems} onClose={() => setMenu(null)} />}
      {refSel && <Menu x={0} y={0} title={`Ref · ${refSel.filename.slice(0, 24)}`} items={refItems} onClose={() => setRefMenu(null)} />}
      <ContextMenuHost title={cardTitle} menu={cardAsset || cardRef ? card : null} items={cardItems} onClose={() => setCard(null)} />
      <NewAssetSheet open={sheet != null} from="library" onClose={() => setSheet(null)} initial={sheet ? { name: sheet.name, kind: sheet.kind, references: sheet.refs } : undefined} onCreated={(c) => { refreshEls(); setSelected(null); setFlash(c.id); setTimeout(() => document.getElementById(`asset-${c.id}`)?.scrollIntoView({ block: "center" }), 400); }} />
    </>
  );

  /* ── phone (M7): the index as pills, the sections two-up ─────────────── */
  if (phone) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink">
        <div ref={column} className="flex min-h-0 flex-1 flex-col gap-[12px] overflow-auto px-[16px] pb-[10px] pt-[16px]" data-phone-body="">
          <span className="flex flex-col gap-[6px]">
            <h1 className="text-[24px] font-semibold leading-[1.05] tracking-[-0.02em] text-ink">Library</h1>
            <Mono>{counts.assets} {counts.assets === 1 ? "asset" : "assets"} · {counts.refs} {counts.refs === 1 ? "reference" : "references"} · {counts.unfiled} unfiled</Mono>
          </span>
          <div className="-mx-[16px] flex gap-[6px] overflow-x-auto px-[16px]" role="navigation" aria-label="Library index" data-index="">
            <button type="button" className={pill(filtering)} aria-expanded={menu?.which === "filters"} onClick={() => setMenu({ which: "filters", x: 0, y: 0, sub: null })}>Filter{filtering ? " · on" : ""} ▾</button>
            <button type="button" className={`${pill(searchOpen)} text-ink-muted`} aria-expanded={searchOpen} onClick={() => setSearchOpen((o) => !o)}>⌕ Search</button>
            {SECTIONS.map((s) => <button key={s.id} type="button" onClick={() => jump(s.id)} aria-current={currentId === s.id ? "true" : undefined} className={pill(currentId === s.id)}>{s.label} · {countOf(s.id)}</button>)}
          </div>
          {searchOpen && (
            <label className="flex h-[44px] items-center gap-[8px] rounded-pill border border-border bg-card px-[12px] text-[16px] text-ink-muted">
              <span className="ui-mono">⌕</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search assets, references, @names…" aria-label="Search the Library" autoFocus className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-muted" />
            </label>
          )}
          <div className="flex flex-col gap-[18px]">{sections}</div>
        </div>
        <PinnedBar>
          <PinnedPrimary cost={money.price(0)} outlined={rail.open || sheet != null || menu != null || refMenu != null || card != null} onClick={() => setSheet({ refs: [] })}>New asset</PinnedPrimary>
        </PinnedBar>
        {overlays}
      </div>
    );
  }

  /* ── desktop (8b): the 52px bar, the index, the sections ─────────────── */
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink">
      <div className="flex h-[52px] flex-none items-center gap-[14px] border-b border-hairline px-[24px]">
        <span className="flex min-w-0 flex-col gap-[4px]">
          <span className="text-[16px] font-semibold leading-none text-ink">Library</span>
          <Mono className="truncate whitespace-nowrap">{counts.assets} {counts.assets === 1 ? "asset" : "assets"} · {counts.refs} {counts.refs === 1 ? "reference" : "references"} · {counts.unfiled} unfiled {counts.unfiled === 1 ? "take" : "takes"} · all productions</Mono>
        </span>
        <span className="ml-[10px] hidden flex-none gap-[6px] lg:flex" data-filters="">
          <button type="button" className={filter} onClick={(e) => setMenu({ which: "production", ...at(e), sub: null })}>Production <span className="text-ink-muted">{production ? prods.productions.find((p) => p.id === production)?.name ?? "any" : "any"}</span> ▾</button>
          <button type="button" className={filter} onClick={(e) => setMenu({ which: "locked", ...at(e), sub: null })}>Locked <span className="text-ink-muted">{locked == null ? "any" : locked ? "locked" : "open"}</span> ▾</button>
          <button type="button" className={filter} onClick={(e) => setMenu({ which: "trained", ...at(e), sub: null })}>Trained <span className="text-ink-muted">{trained == null ? "any" : trained ? "trained" : "not trained"}</span> ▾</button>
        </span>
        <button type="button" className={`${filter} ml-[10px] flex-none lg:hidden`} aria-expanded={menu?.which === "filters"} onClick={(e) => setMenu({ which: "filters", ...at(e), sub: null })}>Filter{filtering ? <span className="text-ink-muted">on</span> : null} ▾</button>
        <span className="ml-auto flex min-w-0 items-center gap-[10px]">
          <label className="flex h-[36px] min-w-0 flex-1 max-w-[240px] items-center gap-[8px] rounded-pill border border-border bg-card px-[12px] text-[13px] text-ink-muted">
            <span className="ui-mono">⌕</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search assets, references, @names…" aria-label="Search the Library" className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-muted" />
          </label>
          <span className="flex-none"><Button variant="primary" placement="header" cost={0} outlined={rail.open} onClick={() => setSheet({ refs: [] })}>New asset</Button></span>
        </span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)] max-lg:grid-cols-[180px_minmax(0,1fr)]">
        <nav className="flex flex-col gap-[2px] border-r border-border px-[16px] py-[24px] max-lg:px-[10px]" aria-label="Library index" data-index="">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" onClick={() => jump(s.id)} aria-current={currentId === s.id ? "true" : undefined}
              className={`flex items-center justify-between gap-[8px] rounded-ctl px-[10px] py-[9px] text-left text-[13.5px] font-medium leading-none ${currentId === s.id ? "bg-selected text-ink" : "text-ink-body"}`}>
              <span>{s.label}</span><span className="text-[12px] text-ink-muted">{countOf(s.id)}</span>
            </button>
          ))}
        </nav>
        <div ref={column} className="flex min-h-0 min-w-0 flex-col gap-[22px] overflow-y-auto px-[24px] pb-[40px] pt-[18px]" data-library="">
          {sections}
        </div>
      </div>
      {overlays}
    </div>
  );
}
