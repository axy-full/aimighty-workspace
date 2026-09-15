"use client";

import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useProject } from "@/lib/projectContext";
import { usePageTitle } from "@/lib/usePageTitle";
import { useAtomikRail } from "@/lib/atomikRail";
import { useUploadFile } from "@/lib/useUploadFile";
import { ELEMENT_KINDS, type ElementKind } from "@/lib/rig";
import type { ElementFull } from "@/lib/elements";
import type { ProductionRow } from "@/lib/productions";
import type { Generation } from "@/lib/jobs";
import { Button, Mono, Segmented, PinnedBar, PinnedPrimary } from "@/components/ui";
import { usePhone } from "@/lib/usePhone";
import { useMoney } from "@/lib/price";
import Menu, { type MenuItem } from "@/components/ui/Menu";
import { ToastHost, useToast } from "@/components/ui/Toast";
import { PageLoader } from "@/components/atomik/Loader";
import UnfiledWall from "@/components/make/UnfiledWall";
import NewAssetSheet, { type SheetRef } from "@/components/assets/NewAssetSheet";

/**
 * Library (design/particl-v2/README.md §11; board 8b): one collection,
 * three lenses — Assets (the cross-production roster), References (the
 * loose board), Unfiled (Make's takes). It indexes project media; it never
 * stores a second copy.
 *
 * Board 8b, value for value: the 52px header (`0 24px`, 14 apart, a .06
 * rule) — `Library` at 600 16 over `12 ASSETS · 38 REFERENCES · 9 UNFILED
 * TAKES · ALL PRODUCTIONS`, the segmented (`8px 14px`, 10 in from the
 * title), the `Kind · Production · Locked` filters (`8px 11px`, .12), the
 * 240px search, and the one filled primary, `New asset · 0 CR` (38px, `0
 * 16px`). Then two panes: the Assets grid (three across, 10 apart; a card
 * on `--card` — `--card-raised` when locked — with its 4:3 still, the kind
 * chip, the lock, the version chip, the name at 600 13.5, `ports · where
 * used` at 400 12) and the 720px References board (dotted, loose; `REF ·
 * …` chips; the selected item in the ring with `Promote to asset · 0 CR`,
 * `Use in Make`, `Add to Canvas`; `Open full board`). The segmented says
 * which lens fills the screen.
 *
 * Below 768 (design/particl-v2-mobile, board M7): `16px 16px`, 12 apart —
 * `Library` at 600 24/1.05 −0.02em over `14 ASSETS · 31 REFERENCES · 9
 * UNFILED`, the segmented full width, the filter pills scrolling edge to
 * edge (`Kind ▾`, `Production ▾`, `Locked`, `⌕ Search`), then the assets
 * two-up (radius 12; the 4:3 still with the kind, lock and version chips
 * at 7/7; the name at 600 13.5; `4 PORTS · HANDBAG TVC` in mono; locked on
 * `--card-raised`). The references lens is the same grid of references —
 * tap one for `Promote to asset · 0 CR`, `Use in Make`, `Add to Canvas` as
 * a sheet; the unfiled lens is Make's wall. `New asset · 0 CR` pinned.
 */
type Lens = "assets" | "references" | "unfiled";
type Upload = { id: string; filename: string; mime: string; bytes: number; width: number | null; height: number | null; kind: "image" | "video"; durationS: number | null; url: string; createdAt: number };
const KIND_WORD: Record<ElementKind, string> = { character: "Character", location: "Location", prop: "Prop", look: "Look", voice: "Voice" };

export default function LibraryPage() {
  return <ToastHost><Library /></ToastHost>;
}

function Library() {
  const uploadFile = useUploadFile();
  const router = useRouter();
  const search = useSearchParams();
  const { signedIn } = useSession();
  const { current } = useProject();
  const toast = useToast();
  const rail = useAtomikRail();
  const phone = usePhone();
  const money = useMoney();
  const [searchOpen, setSearchOpen] = useState(false);
  const [refMenu, setRefMenu] = useState<string | null>(null);
  usePageTitle("Library");
  const [lens, setLens] = useState<Lens>(() => (search.get("view") === "unfiled" ? "unfiled" : search.get("view") === "references" ? "references" : "assets"));
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<ElementKind | null>(null);
  const [production, setProduction] = useState<string | null>(null);
  const [locked, setLocked] = useState<boolean | null>(null);
  const [menu, setMenu] = useState<{ which: "kind" | "production" | "locked"; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [sheet, setSheet] = useState<{ refs: SheetRef[]; name?: string } | null>(null);

  const { data: els, refresh: refreshEls } = useApi<{ elements: ElementFull[] }>(signedIn ? "/api/rig/elements" : null, 30_000);
  const { data: ups, refresh: refreshUps } = useApi<{ uploads: Upload[] }>(signedIn ? "/api/uploads?limit=300" : null, 30_000);
  const { data: prods } = useApi<{ productions: ProductionRow[] }>(signedIn ? "/api/productions" : null, 60_000);
  const { data: unfiled } = useApi<{ generations: Generation[] }>(signedIn ? "/api/jobs?unfiled=1&limit=200&sync=0" : null, 30_000);
  const productionOf = (projectId: string | null) => (projectId ? prods?.productions.find((p) => p.projects.some((j) => j.id === projectId)) ?? null : null);

  const needle = q.trim().toLowerCase();
  const assets = useMemo(() => (els?.elements ?? []).filter((e) =>
    (!kind || e.kind === kind) && (!production || productionOf(e.projectId)?.id === production) && (locked == null || e.locked === locked)
    && (!needle || `${e.name} @${e.name} ${e.kind} ${e.description}`.toLowerCase().includes(needle))), [els, kind, production, locked, needle, prods]); // eslint-disable-line react-hooks/exhaustive-deps
  const refs = useMemo(() => (ups?.uploads ?? []).filter((u) => !needle || u.filename.toLowerCase().includes(needle)), [ups, needle]);
  const sel = refs.find((u) => u.id === selected) ?? null;

  /* The loose board: each reference in its own place, laid in four columns as it arrived. */
  const placed = useMemo(() => {
    const cols = [0, 0, 0, 0]; const w = 160; const gap = 16;
    return refs.map((u, i) => {
      const c = i % 4; const h = u.width && u.height ? Math.max(90, Math.min(220, Math.round((w * u.height) / u.width))) : 120;
      const y = cols[c]; cols[c] += h + gap;
      return { u, x: 16 + c * (w + gap), y, w, h };
    });
  }, [refs]);

  const picker = useRef<HTMLInputElement>(null);
  const drop = async (files: FileList | File[]) => {
    const list = Array.from(files).slice(0, 12);
    if (!list.length) return;
    try { for (const f of list) await uploadFile(f, "reference"); toast(`${list.length} ${list.length === 1 ? "reference" : "references"} on the board`); refreshUps(); }
    catch (e) { toast((e as Error).message); }
  };

  const kindItems = (onPick: (k: ElementKind) => void): MenuItem[] => ELEMENT_KINDS.map((k) => ({ kind: "item", label: KIND_WORD[k], onSelect: () => onPick(k) }));
  const menuItems: MenuItem[] = !menu ? [] : menu.which === "kind"
    ? [{ kind: "item", label: "Any", onSelect: () => setKind(null) }, ...kindItems((k) => setKind(k))]
    : menu.which === "production"
      ? [{ kind: "item", label: "Any", onSelect: () => setProduction(null) }, ...(prods?.productions ?? []).map((p): MenuItem => ({ kind: "item", label: p.name, onSelect: () => setProduction(p.id) }))]
      : [{ kind: "item", label: "Any", onSelect: () => setLocked(null) }, { kind: "item", label: "Locked", onSelect: () => setLocked(true) }, { kind: "item", label: "Open", onSelect: () => setLocked(false) }];
  const at = (e: React.MouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return { x: r.left, y: r.bottom + 6 }; };

  const counts = { assets: els?.elements.length ?? 0, refs: ups?.uploads.length ?? 0, unfiled: unfiled?.generations.length ?? 0 };
  const filter = "tap44 flex items-center gap-[5px] rounded-pill border border-[rgba(245,246,248,.12)] px-[11px] py-[8px] text-[12.5px] font-medium leading-none text-ink";
  const showAssets = lens === "assets" || (lens === "references" && !full && false);
  const showRefs = lens === "assets" || lens === "references";

  if (!signedIn) return <div className="p-[24px] text-[13px] text-ink-body">Sign in to open the Library.</div>;
  if (!els || !ups || !prods) return <PageLoader what="Opening · Library" />;

  if (phone) {
    const pill = (on: boolean) => `tap44 flex flex-none items-center gap-[6px] rounded-pill border border-[rgba(245,246,248,.12)] px-[11px] py-[8px] text-[12.5px] font-medium leading-none ${on ? "bg-[rgba(245,246,248,.1)] text-ink" : "text-ink-body"}`;
    const refSel = refs.find((u) => u.id === refMenu) ?? null;
    const refItems: MenuItem[] = refSel ? [
      { kind: "item", label: "Promote to asset", keys: money.price(0), onSelect: () => setSheet({ refs: [{ uploadId: refSel.id, url: refSel.url, label: refSel.filename, kind: refSel.kind }], name: refSel.filename.replace(/\.[a-z0-9]+$/i, "").replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() + w.slice(1)).join("") }) },
      { kind: "item", label: "Use in Make", onSelect: () => router.push(`/make/${refSel.kind === "video" ? "video" : "images"}?ref=${encodeURIComponent(refSel.id)}`) },
      { kind: "item", label: "Add to Canvas", onSelect: () => current ? router.push(`/rig/canvas/new?project=${encodeURIComponent(current.id)}&ref=${encodeURIComponent(refSel.id)}`) : toast("Pick a project first — Canvas belongs to a project.") },
      { kind: "note", text: "References are free and unversioned until promoted." },
    ] : [];
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink">
        <div className="flex min-h-0 flex-1 flex-col gap-[12px] overflow-auto px-[16px] pb-[10px] pt-[16px]" data-phone-body="">
          <span className="flex flex-col gap-[6px]">
            <h1 className="text-[24px] font-semibold leading-[1.05] tracking-[-0.02em] text-ink">Library</h1>
            <Mono>{counts.assets} {counts.assets === 1 ? "asset" : "assets"} · {counts.refs} {counts.refs === 1 ? "reference" : "references"} · {counts.unfiled} unfiled</Mono>
          </span>
          <Segmented label="Lens" fill value={lens} onChange={(l) => { setLens(l); setFull(false); }} options={[{ value: "assets", label: "Assets" }, { value: "references", label: "References" }, { value: "unfiled", label: "Unfiled" }]} />
          <div className="-mx-[16px] flex gap-[6px] overflow-x-auto px-[16px]" data-filters="">
            {lens === "assets" && <>
              <button type="button" className={pill(kind != null)} onClick={(e) => setMenu({ which: "kind", ...at(e) })}>Kind{kind ? ` · ${KIND_WORD[kind]}` : ""} ▾</button>
              <button type="button" className={pill(production != null)} onClick={(e) => setMenu({ which: "production", ...at(e) })}>Project{production ? ` · ${prods.productions.find((p) => p.id === production)?.name ?? ""}` : ""} ▾</button>
              <button type="button" className={pill(locked === true)} aria-pressed={locked === true} onClick={() => setLocked((l) => (l === true ? null : true))}>Locked</button>
            </>}
            {lens === "references" && <button type="button" className={pill(false)} onClick={() => picker.current?.click()}>+ Add references</button>}
            {lens !== "unfiled" && <button type="button" className={`${pill(searchOpen)} text-ink-muted`} aria-expanded={searchOpen} onClick={() => setSearchOpen((o) => !o)}>⌕ Search</button>}
          </div>
          {searchOpen && lens !== "unfiled" && (
            <label className="flex h-[44px] items-center gap-[8px] rounded-pill border border-border bg-card px-[12px] text-ink-muted">
              <span className="ui-mono tracking-normal">⌕</span>
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search assets, references, @names…" aria-label="Search the Library" className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-0 placeholder:text-ink-muted" />
            </label>
          )}
          {lens === "assets" && (
            <div className="grid grid-cols-2 gap-[10px]" data-assets="">
              {assets.map((a) => {
                const first = a.attributes[0];
                const cur = first?.versions.find((v) => v.id === first.currentId) ?? first?.versions[0] ?? null;
                const vn = cur ? first!.versions.findIndex((v) => v.id === cur.id) + 1 : 0;
                const prod = productionOf(a.projectId);
                return (
                  <article key={a.id} className={`flex flex-col overflow-hidden rounded-card border border-border ${a.locked ? "bg-card-raised" : "bg-card"}`} aria-label={`${KIND_WORD[a.kind]} @${a.name}`}>
                    <span className="relative block aspect-[4/3] border-b border-hairline ui-placeholder">
                      {cur?.uploadId && <img src={`/api/uploads/${encodeURIComponent(cur.uploadId)}`} alt="" className="absolute inset-0 h-full w-full object-cover" />}
                      <span className="ui-chip-scrim absolute left-[7px] top-[7px] rounded-badge px-[6px] py-[4px]"><span className="ui-mono text-ink">{a.kind}</span></span>
                      {a.locked && <span className="ui-chip-scrim absolute right-[7px] top-[7px] flex rounded-badge px-[6px] py-[4px]" title={`Locked${a.lockedBy ? ` by ${a.lockedBy}` : ""}`}><svg viewBox="0 0 12 12" width="11" height="11" style={{ fill: "none", stroke: "var(--ink)", strokeWidth: 1.3 }} aria-hidden="true"><rect x="2" y="5.4" width="8" height="5.4" rx="1.2" /><path d="M4 5.4V4a2 2 0 0 1 4 0v1.4" /></svg></span>}
                      <span className="ui-chip-scrim absolute bottom-[7px] right-[7px] rounded-badge px-[6px] py-[4px]"><span className="ui-mono tracking-normal text-ink">{vn ? `v${vn}` : "—"}</span></span>
                    </span>
                    <span className="flex flex-col gap-[5px] px-[10px] pb-[10px] pt-[9px]">
                      <span className="truncate text-[13.5px] font-semibold leading-[1.2] text-ink">@{a.name}</span>
                      <Mono cost className="truncate">{a.attributes.length} {a.attributes.length === 1 ? "port" : "ports"} · {prod ? prod.name : "all projects"}</Mono>
                    </span>
                  </article>
                );
              })}
              {!assets.length && <span className="col-span-2 text-[13px] leading-[1.5] text-ink-body" style={{ textWrap: "pretty" }}>{els.elements.length ? "Nothing matches those filters." : "No assets yet. Promote a reference, or make one with New asset — creating is free."}</span>}
            </div>
          )}
          {lens === "references" && (
            <div className="grid grid-cols-2 gap-[10px]" data-references="">
              <input ref={picker} type="file" accept="image/*,video/*" multiple hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { if (e.target.files) drop(e.target.files); e.target.value = ""; }} />
              {refs.map((u) => (
                <button key={u.id} type="button" onClick={() => setRefMenu(u.id)} aria-label={`Reference · ${u.filename}`}
                  className="relative box-border aspect-[4/3] overflow-hidden rounded-tile border border-[rgba(245,246,248,.1)] text-left ui-placeholder">
                  {u.kind === "image" && <img src={u.url} alt="" className="absolute inset-0 h-full w-full object-cover" />}
                  <span className="ui-chip-scrim absolute bottom-[6px] left-[6px] max-w-[calc(100%-12px)] truncate rounded-badge px-[6px] py-[4px]"><span className="ui-mono text-ink">Ref · {u.filename.replace(/\.[a-z0-9]+$/i, "").slice(0, 18)}</span></span>
                </button>
              ))}
              {!refs.length && <span className="col-span-2 text-[13px] leading-[1.5] text-ink-body">Nothing on the board yet. Add images or clips.</span>}
            </div>
          )}
          {lens === "unfiled" && <UnfiledWall kind="all" search={q} phone />}
        </div>
        <PinnedBar>
          <PinnedPrimary cost={money.price(0)} outlined={rail.open || sheet != null || menu != null || refMenu != null} onClick={() => setSheet({ refs: [] })}>New asset</PinnedPrimary>
        </PinnedBar>
        {menu && <Menu x={menu.x} y={menu.y} title={menu.which === "kind" ? "Kind" : menu.which === "production" ? "Project" : "Locked"} items={menuItems} onClose={() => setMenu(null)} />}
        {refSel && <Menu x={0} y={0} title={`Ref · ${refSel.filename.slice(0, 24)}`} items={refItems} onClose={() => setRefMenu(null)} />}
        <NewAssetSheet open={sheet != null} from="library" onClose={() => setSheet(null)} initial={sheet ? { name: sheet.name, references: sheet.refs } : undefined} onCreated={() => { refreshEls(); setLens("assets"); setSelected(null); }} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink">
      <div className="flex h-[52px] flex-none items-center gap-[14px] border-b border-hairline px-[24px]">
        <span className="flex flex-none flex-col gap-[4px]"><span className="text-[16px] font-semibold leading-none text-ink">Library</span><Mono className="whitespace-nowrap">{counts.assets} {counts.assets === 1 ? "asset" : "assets"} · {counts.refs} {counts.refs === 1 ? "reference" : "references"} · {counts.unfiled} unfiled {counts.unfiled === 1 ? "take" : "takes"} · all projects</Mono></span>
        <Segmented label="Lens" placement="toolbar" className="ml-[10px] max-md:ml-0" value={lens} onChange={(l) => { setLens(l); setFull(false); }} options={[{ value: "assets", label: "Assets" }, { value: "references", label: "References" }, { value: "unfiled", label: "Unfiled" }]} />
        {lens === "assets" && (
          <span className="flex flex-none gap-[6px] max-md:hidden">
            <button type="button" className={filter} onClick={(e) => setMenu({ which: "kind", ...at(e) })}>Kind <span className="text-ink-muted">{kind ? KIND_WORD[kind] : "any"}</span> ▾</button>
            <button type="button" className={filter} onClick={(e) => setMenu({ which: "production", ...at(e) })}>Project <span className="text-ink-muted">{production ? prods.productions.find((p) => p.id === production)?.name ?? "any" : "any"}</span> ▾</button>
            <button type="button" className={filter} onClick={(e) => setMenu({ which: "locked", ...at(e) })}>Locked <span className="text-ink-muted">{locked == null ? "any" : locked ? "locked" : "open"}</span> ▾</button>
          </span>
        )}
        <span className="ml-auto flex items-center gap-[10px] max-md:w-full">
          <label className="flex h-[36px] w-[240px] items-center gap-[8px] rounded-pill border border-border bg-card px-[12px] text-[13px] text-ink-muted max-md:h-[44px] max-md:w-full">
            <span className="ui-mono !text-[12px] tracking-normal">⌕</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search assets, references, @names…" aria-label="Search the Library" className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-0 placeholder:text-ink-muted max-md:text-[16px]" />
          </label>
          <Button variant="primary" placement="header" cost={0} outlined={rail.open} onClick={() => setSheet({ refs: [] })}>New asset</Button>
        </span>
      </div>
      {lens === "unfiled" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-auto px-[24px] pb-[24px] pt-[18px] max-md:px-[16px]">
          <UnfiledWall kind="all" search={q} columns={rail.state === "expanded" ? "grid-cols-2" : rail.state === "compact" ? "grid-cols-3" : "grid-cols-4"} />
        </div>
      ) : (
        <div className={`grid min-h-0 flex-1 ${lens === "references" || full ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_720px]"} max-md:grid-cols-1`}>
          {showAssets && lens === "assets" && !full && (
            <div className="flex min-h-0 flex-col gap-[12px] overflow-auto px-[24px] pb-[24px] pt-[18px] max-md:px-[16px]">
              <Mono>Assets · canonical still · version · ports · where used</Mono>
              <div className="grid grid-cols-3 gap-[10px] max-md:grid-cols-2" data-assets="">
                {assets.map((a) => {
                  const first = a.attributes[0];
                  const cur = first?.versions.find((v) => v.id === first.currentId) ?? first?.versions[0] ?? null;
                  const vn = cur ? first!.versions.findIndex((v) => v.id === cur.id) + 1 : 0;
                  const prod = productionOf(a.projectId);
                  return (
                    <article key={a.id} className={`flex flex-col overflow-hidden rounded-card border border-[rgba(245,246,248,.1)] ${a.locked ? "bg-card-raised" : "bg-card"}`} aria-label={`${KIND_WORD[a.kind]} @${a.name}`}>
                      <span className="relative block aspect-[4/3] border-b border-hairline ui-placeholder">
                        {cur?.uploadId && <img src={`/api/uploads/${encodeURIComponent(cur.uploadId)}`} alt="" className="absolute inset-0 h-full w-full object-cover" />}
                        <span className="ui-chip-scrim absolute left-[8px] top-[8px] rounded-badge px-[6px] py-[4px]"><span className="ui-mono text-ink">{a.kind}</span></span>
                        {a.locked && <span className="ui-chip-scrim absolute right-[8px] top-[8px] flex h-[24px] w-[24px] items-center justify-center rounded-[6px]" title={`Locked${a.lockedBy ? ` by ${a.lockedBy}` : ""}`}><svg viewBox="0 0 12 12" width="11" height="11" style={{ fill: "none", stroke: "var(--ink)", strokeWidth: 1.3 }} aria-hidden="true"><rect x="2" y="5.4" width="8" height="5.4" rx="1.2" /><path d="M4 5.4V4a2 2 0 0 1 4 0v1.4" /></svg></span>}
                        <span className="ui-chip-scrim absolute bottom-[8px] right-[8px] rounded-badge px-[6px] py-[4px]"><span className="ui-mono tracking-normal text-ink-body">{vn ? `v${vn}` : "—"}</span></span>
                      </span>
                      <span className="flex flex-col gap-[5px] px-[11px] pb-[11px] pt-[9px]">
                        <span className="truncate text-[13.5px] font-semibold leading-[1.2] text-ink">@{a.name}</span>
                        <span className="truncate text-[12px] leading-[1.3] text-ink-body">{a.attributes.length} {a.attributes.length === 1 ? "port" : "ports"} · {prod ? prod.name : "all projects"}</span>
                      </span>
                    </article>
                  );
                })}
                {!assets.length && <span className="col-span-3 text-[13px] leading-[1.5] text-ink-body" style={{ textWrap: "pretty" }}>{els.elements.length ? "Nothing matches those filters." : "No assets yet. Promote a reference from the board, or make one with New asset — creating is free."}</span>}
              </div>
            </div>
          )}
          {showRefs && (
            <section className={`relative min-w-0 overflow-auto ${lens === "assets" && !full ? "border-l border-border max-md:border-l-0 max-md:border-t" : ""} max-md:min-h-[520px]`} aria-label="References"
              style={{ backgroundImage: "radial-gradient(rgba(245,246,248,.07) 1px, transparent 1px)", backgroundSize: "24px 24px" }}
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) drop(e.dataTransfer.files); }}
              onPointerDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
              <input ref={picker} type="file" accept="image/*,video/*" multiple hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { if (e.target.files) drop(e.target.files); e.target.value = ""; }} />
              <span className="absolute left-[16px] top-[14px] z-[3] flex items-center gap-[8px]">
                <Mono className="rounded-badge bg-ground px-[6px] py-[4px]">References · loose board · drop anything</Mono>
                <button type="button" onClick={() => { if (lens === "assets") setFull((f) => !f); else picker.current?.click(); }} className="tap44 flex h-[28px] items-center rounded-pill border border-border-mid bg-ground px-[10px] text-[12px] font-medium leading-none text-ink">{lens === "assets" ? (full ? "Back to assets" : "Open full board") : "Add references"}</button>
              </span>
              <div className="relative" style={{ height: Math.max(420, ...placed.map((p) => p.y + p.h + 60)) + 36 }}>
                {placed.map(({ u, x, y, w, h }) => {
                  const on = selected === u.id;
                  return (
                    <button key={u.id} type="button" onClick={(e) => { e.stopPropagation(); setSelected(on ? null : u.id); }} aria-label={`Reference · ${u.filename}`} aria-pressed={on}
                      className={`absolute mt-[36px] box-border overflow-hidden rounded-tile border ui-placeholder ${on ? "border-ink shadow-[0_0_0_3px_rgba(245,246,248,.1)]" : "border-[rgba(245,246,248,.1)]"}`} style={{ left: x, top: y, width: w, height: h }}>
                      {u.kind === "image" && <img src={u.url} alt="" className="absolute inset-0 h-full w-full object-cover" />}
                      <span className="ui-chip-scrim absolute bottom-[6px] left-[6px] max-w-[calc(100%-12px)] truncate rounded-badge px-[6px] py-[4px]"><span className="ui-mono text-ink">Ref · {u.filename.replace(/\.[a-z0-9]+$/i, "").slice(0, 18)}</span></span>
                    </button>
                  );
                })}
                {sel && (() => { const p = placed.find((x) => x.u.id === sel.id)!; return (
                  <span className="absolute z-[3] flex gap-[6px]" style={{ left: p.x, top: p.y + p.h + 36 + 8 }}>
                    <button type="button" onClick={() => setSheet({ refs: [{ uploadId: sel.id, url: sel.url, label: sel.filename, kind: sel.kind }], name: sel.filename.replace(/\.[a-z0-9]+$/i, "").replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() + w.slice(1)).join("") })} className="tap44 flex h-[34px] items-center gap-[8px] rounded-pill border border-[rgba(245,246,248,.3)] bg-ground px-[12px] text-[12.5px] font-medium leading-none text-ink">Promote to asset<Mono cost>0 cr</Mono></button>
                    <button type="button" onClick={() => router.push(`/make/${sel.kind === "video" ? "video" : "images"}?ref=${encodeURIComponent(sel.id)}`)} className="tap44 flex h-[34px] items-center rounded-pill border border-border-mid bg-ground px-[12px] text-[12.5px] font-medium leading-none text-ink">Use in Make</button>
                    <button type="button" onClick={() => current ? router.push(`/rig/canvas/new?project=${encodeURIComponent(current.id)}&ref=${encodeURIComponent(sel.id)}`) : toast("Pick a project first — Canvas belongs to a project.")} className="tap44 flex h-[34px] items-center rounded-pill border border-border-mid bg-ground px-[12px] text-[12.5px] font-medium leading-none text-ink-body">Add to Canvas</button>
                  </span>
                ); })()}
                {!placed.length && <span className="absolute left-[16px] top-[60px] text-[13px] leading-[1.5] text-ink-body">Nothing on the board yet. Drop images or clips here.</span>}
              </div>
              <span className="absolute bottom-[16px] left-[16px] max-w-[420px] rounded-ctl border border-border bg-ground px-[10px] py-[8px] text-[12.5px] leading-[1.45] text-ink-body" style={{ textWrap: "pretty" }}>References are free and unversioned until promoted. Promoting makes the item the asset&rsquo;s first version.</span>
            </section>
          )}
        </div>
      )}
      {menu && <Menu x={menu.x} y={menu.y} title={menu.which === "kind" ? "Kind" : menu.which === "production" ? "Project" : "Locked"} items={menuItems} onClose={() => setMenu(null)} />}
      <NewAssetSheet open={sheet != null} from="library" onClose={() => setSheet(null)} initial={sheet ? { name: sheet.name, references: sheet.refs } : undefined} onCreated={() => { refreshEls(); setLens("assets"); setSelected(null); }} />
    </div>
  );
}
