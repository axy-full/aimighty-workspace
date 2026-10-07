"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useMoney } from "@/lib/price";
import { useProject } from "@/lib/projectContext";
import { useUploadFile } from "@/lib/useUploadFile";
import type { ElementKind } from "@/lib/rig";
import type { Generation } from "@/lib/jobs";
import { Mono } from "@/components/ui";
import Sheet from "@/components/ui/Sheet";
import { usePhone } from "@/lib/usePhone";
import Menu, { type MenuItem } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import Loader, { LOADER_SIZES } from "@/components/atomik/Loader";
import { assetUploadPurpose } from "@/lib/identityTraining";

/**
 * The New asset sheet (design/particl-graphite/README.md §12; boards 3a, 3b):
 * one sheet, opened from the Library, Rig, a take, a Canvas selection, an
 * unknown `@name` in a prompt, or Atomik.
 *
 * Board 3a, value for value: a 760px card (`--card`, .14, radius 16) over
 * the `rgba(5,6,8,.55)` scrim. The header (`16px 20px`, .08): `New asset`
 * at 600 17, `NAME · KIND · REFERENCES · THAT'S IT`, `FROM <where>` and the
 * 32px close. Row 1: the name (a 48px field on ground, .14, radius 10, 600
 * 20, under `NAME · YOU'LL TYPE IT AS @ROWAN`) and the kind (48px buttons,
 * radius 10, `0 14px`, 500 13.5). Row 2: the references well (dashed .22,
 * radius 12, 10px; 64px thumbs; `Drop more, or pick from` `Upload · A take
 * · Make · Canvas`). Row 3: `WHAT PARTICL READS FROM THESE` — one tile per
 * derived port (ground, .1, radius 10, 8px; a 56px well with its tag; the
 * state dot and word; a line) with `READY / LATER / OPTIONAL`. Row 4: the
 * train switch (ground, .1, radius 12, `12px 14px`; a 36×20 switch) with
 * its price. The foot: the mono consequence line, `Cancel` (46px, .14,
 * radius 12), and the primary `Create Rowan · 12 CR` (46px, radius 12).
 *
 * No training starts here (review of #558, L-A). Every identity training
 * cites a live consent record for a production and a cast member
 * (lib/security/consent.ts, consentForTraining), and this sheet has
 * neither, so a character's row points to the Cast card on the board,
 * where consent is recorded, instead of offering a switch that is always
 * refused. The other kinds keep their "later" row.
 *
 * Rules (§12): creating is free; learning costs; attributes are read from
 * references, never typed. A character exists the moment it has a name and
 * one picture.
 *
 * Below 768 (design/particl-graphite, board M8) the same sheet is full
 * height from 44px: `New asset` at 600 20 over `NAME · KIND · REFERENCES
 * · THAT'S IT` with `FROM LIBRARY` at the right; the name field at 52px
 * in 20px type; the kind pills at 44px (the chosen one filled ink); the
 * references well (64px thumbs, `+ Add` opening Upload · A take · Make ·
 * Canvas as a sheet); `WHAT PARTICL READS FROM THESE` as two-up tiles
 * (`READY` in the accent, `LATER` muted, `OPTIONAL` body); the train row
 * with its 52×32 switch; and the pinned `Create Rowan · 12 CR` under the
 * consequence line. The dock is hidden behind it.
 */
export type SheetFrom = "library" | "rig" | "take" | "canvas" | "prompt" | "atomik";
export type SheetRef = { uploadId?: string | null; genId?: string | null; url: string | null; label: string; kind: "image" | "video" | "audio" };
export type Created = { id: string; name: string; kind: ElementKind };

const FROM_LABEL: Record<SheetFrom, string> = { library: "Library", rig: "Rig · Canvas", take: "A take", canvas: "Canvas · selection", prompt: "A prompt", atomik: "Atomik" };
const KIND_WORD: Record<ElementKind, string> = { character: "Character", prop: "Prop", location: "Location", look: "Look", voice: "Voice" };
/** The order §12 lists them in: Character · Prop · Location · Look · Voice. */
const KIND_ORDER: ElementKind[] = ["character", "prop", "location", "look", "voice"];
/** A face trains only against a consent record, and the record lives on the board's Cast card (review of #558, L-A). */
const TRAIN_FROM_CAST = "Train it from the Cast card, where its consent is recorded.";
const CAST_KIND: Partial<Record<ElementKind, "character" | "location" | "prop" | "style">> = { character: "character", prop: "prop", location: "location", look: "style" };

type PortState = "ready" | "later" | "optional";
type Port = { tag: string; state: PortState; note: string };

/** What particl reads from the references, by kind (§12). */
function portsFor(kind: ElementKind, refs: SheetRef[]): Port[] {
  const stills = refs.filter((r) => r.kind === "image").length;
  const audio = refs.filter((r) => r.kind === "audio").length;
  const has = (n: number): PortState => (stills >= n ? "ready" : "later");
  switch (kind) {
    case "character": return [
      { tag: "FACE", state: has(1), note: stills ? "From the clearest still. Train it for a likeness that holds." : "Needs one still." },
      { tag: "HAIR", state: has(1), note: "Read from the same stills." },
      { tag: "WARDROBE", state: has(2), note: stills >= 2 ? "From the second still on." : "A second still shows the wardrobe." },
      { tag: "VOICE", state: audio ? "ready" : "optional", note: audio ? "From the clip." : "Add a clip any time." },
    ];
    case "prop": return [
      { tag: "HERO", state: has(1), note: "The canonical still." },
      { tag: "DETAIL", state: has(2), note: stills >= 2 ? "From the second still on." : "A second, closer still." },
      { tag: "TURNTABLE", state: "later", note: "Made from the hero when its engine is connected." },
    ];
    case "location": return [
      ...refs.filter((r) => r.kind === "image").slice(0, 3).map((r, i) => ({ tag: `PLATE ${String(i + 1).padStart(2, "0")}`, state: "ready" as PortState, note: r.label.slice(0, 28) })),
      { tag: stills ? "MORE HOURS" : "PLATE 01", state: "later" as PortState, note: stills ? "Plates by hour, as you add them." : "Needs one plate." },
    ].slice(0, 4);
    case "look": return [
      { tag: "LOOK", state: has(1), note: "Colour and light, read from the stills." },
      { tag: "GRAIN", state: "later", note: "Read once a keyframe carries it." },
    ];
    case "voice": return [
      { tag: "VOICE", state: audio ? "ready" : "later", note: audio ? "From the clip." : "Needs a clip." },
      { tag: "LANGUAGE", state: audio ? "ready" : "later", note: "Heard in the clip." },
    ];
  }
}

type SheetProps = {
  open: boolean; onClose: () => void; from: SheetFrom;
  initial?: { name?: string; kind?: ElementKind; references?: SheetRef[]; description?: string };
  onCreated?: (c: Created) => void;
};

/** Mounted only while open, so every opening starts from `initial` — no state to reset. */
export default function NewAssetSheet(props: SheetProps) {
  const {workspace,email}=useSession();
  return props.open ? <SheetBody key={JSON.stringify([workspace?.id,email])} {...props} /> : null;
}

function SheetBody({ onClose, from, initial, onCreated }: SheetProps) {
  const uploadFile = useUploadFile();
  const router = useRouter();
  const { signedIn } = useSession();
  const { current } = useProject();
  const money = useMoney();
  const toast = useToast();
  const [name,setName]=useState(initial?.name??"");
  const [kind,setKind]=useState<ElementKind>(initial?.kind??"character");
  const [refs,setRefs]=useState<SheetRef[]>(initial?.references??[]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [takeMenu, setTakeMenu] = useState<{ x: number; y: number } | null>(null);
  const [sourceMenu, setSourceMenu] = useState(false);
  const phone = usePhone();
  const picker = useRef<HTMLInputElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  /* §13 · Train on create: "never" hides the row. */
  const { data: ws } = useApi<{ settings: Record<string, string> }>(signedIn ? "/api/settings" : null, 0);
  const trainRule = ws?.settings.trainOnCreate === "never" ? "never" : "show";
  const { data: takes } = useApi<{ generations: Generation[] }>(takeMenu && signedIn ? "/api/jobs?kind=image&status=succeeded&limit=24&sync=0" : null, 0);

  useEffect(() => {
    const t = setTimeout(() => nameField.current?.focus(), 50);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => { clearTimeout(t); window.removeEventListener("keydown", key); };
  }, [onClose]);

  const tag = `@${(name.trim() || "Name").replace(/\s+/g, "")}`;
  const ports = useMemo(() => portsFor(kind, refs), [kind, refs]);
  const stills = refs.filter((r) => r.kind === "image");
  /* A face trains from the Cast card, where its consent is recorded; the sheet only points there (L-A). */
  const trainable = kind === "character";
  const trainLabel = kind === "prop" ? "Make a turntable later" : kind === "location" ? "Fill the missing hour later" : kind === "look" ? "Apply to existing keyframes later" : "Train the voice later";
  const trainNote = "No engine is connected for this yet. It will be priced from the engine when one is, from Rig.";
  const shownPrice = money.price(0);
  const note = `Creates ${tag} with ${stills.length ? "a still" : "no picture yet"}${trainable ? "" : " · attributes read from the references"} · 0 CR`;

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).slice(0, 12);
    if (!list.length) return;
    setUploading(true);
    try {
      for (const f of list) {
        /* A clip for a voice is a file, not a reference still: the reference intake reads pictures and video only. */
        const up = await uploadFile(f, assetUploadPurpose(f));
        setRefs((prev) => prev.some((r) => r.uploadId === up.id) ? prev : [...prev, { uploadId: up.id, url: up.url, label: up.filename, kind: up.kind === "video" ? "video" : up.kind === "file" || up.kind === "audio" ? "audio" : "image" }]);
      }
    } catch (e) { toast((e as Error).message); }
    finally { setUploading(false); }
  };
  const takeItems: MenuItem[] = (takes?.generations ?? []).filter((g) => g.storedUrl ?? g.sourceUrl).slice(0, 12).map((g): MenuItem => ({
    kind: "item", label: `${g.shotCode ? `${g.shotCode} v${g.version}` : "Unfiled"} · ${((g.params as { rawPrompt?: string }).rawPrompt || g.prompt).slice(0, 30)}`,
    onSelect: () => setRefs((prev) => prev.some((r) => r.genId === g.id) ? prev : [...prev, { genId: g.id, url: g.storedUrl ?? g.sourceUrl, label: g.shotCode ? `${g.shotCode} v${g.version}` : "take", kind: "image" }]),
  }));

  const create = async () => {
    if (!signedIn || busy) return;
    const clean = name.trim();
    if (!clean) { toast("Name it first — you'll type it as @Name."); nameField.current?.focus(); return; }
    setBusy(true);
    try {
      let castId: string | null = null;
      if (CAST_KIND[kind]) {
        /* A name the prompt can cite, carrying its still. */
        const r = await fetch("/api/cast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: clean, kind: CAST_KIND[kind], description: initial?.description ?? "", uploadId: stills[0]?.uploadId ?? null }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok && r.status !== 409) throw new Error(j.error ?? "The name wasn't added to the cast.");
        castId = j.member?.id ?? null;
      }
      const first = refs[0];
      const r = await fetch("/api/rig/elements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        name: clean, kind, description: initial?.description ?? "", castId, identityId: null,
        fromUploadId: first?.uploadId ?? null, fromGenId: first?.genId ?? null,
        references: refs.map((x) => ({ uploadId: x.uploadId ?? null, genId: x.genId ?? null })),
      }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "The asset wasn't created.");
      toast(`${tag} created · 0 CR`);
      onCreated?.({ id: j.element.id, name: j.element.name, kind });
      onClose();
    } catch (e) {
      toast((e as Error).message);
    }
    finally { setBusy(false); }
  };

  const kindBtn = (k: ElementKind) => `tap44 h-[48px] rounded-tile border px-[14px] text-[13.5px] font-medium leading-none ${k === kind ? "border-[color:var(--gx-hover-border)] bg-[color:var(--gx-input-hover)] text-ink" : "border-[color:var(--gx-pop-border)] text-ink-body"}`;
  const source = "tap44 whitespace-nowrap rounded-pill border border-border-mid px-[9px] py-[7px] text-[12px] font-medium leading-none text-ink";
  const sourceItems: MenuItem[] = [
    { kind: "item", label: "Upload", onSelect: () => picker.current?.click() },
    { kind: "item", label: "A take", onSelect: () => setTakeMenu({ x: 0, y: 0 }) },
    { kind: "item", label: "Make", onSelect: () => { onClose(); router.push("/make/images"); } },
    { kind: "item", label: "Canvas", onSelect: () => { if (!current) { toast("Pick a project first — Canvas belongs to a project."); return; } onClose(); router.push(`/rig/canvas/new?project=${encodeURIComponent(current.id)}`); } },
  ];
  const takesMenu = takeMenu && <Menu x={takeMenu.x} y={takeMenu.y} title="A take · the newest stills" items={takeItems.length ? takeItems : [{ kind: "note", text: takes ? "No finished stills yet." : "Loading…" }]} onClose={() => setTakeMenu(null)} />;

  if (phone) return (
    <>
      <Sheet open onClose={onClose} label="New asset" top={44} footerPad="8px 16px 26px" bodyClassName="!gap-[14px]"
        header={
          <div className="flex flex-none items-center gap-[10px] px-[16px] pb-[10px] pt-[12px]">
            <span className="flex min-w-0 flex-col gap-[5px]"><span className="text-[20px] font-semibold leading-[1.1] text-ink">New asset</span><Mono className="truncate">Name · kind · references · that&rsquo;s it</Mono></span>
            <Mono className="ml-auto flex-none rounded-pill border border-border-mid px-[9px] py-[7px]">From {FROM_LABEL[from]}</Mono>
          </div>
        }
        footer={
          <span className="flex w-full flex-col gap-[8px]">
            <Mono cost className="text-center !leading-[1.4]">{note}</Mono>
            <button type="button" onClick={create} disabled={busy || !signedIn} data-create=""
              className="flex h-[52px] w-full items-center justify-between rounded-mobile bg-action hover:bg-action-hover px-[16px] text-[15px] font-semibold leading-none text-on-action disabled:opacity-60">
              <span className="flex items-center gap-[10px]">{busy ? <Loader size={LOADER_SIZES.button} on="primary" /> : null}Create {name.trim() || "asset"}</span>
              <span className="ui-mono ui-mono-cost !text-[12px] text-on-primary-cost">{shownPrice}</span>
            </button>
          </span>
        }>
        <label className="flex flex-col gap-[6px]">
          <Mono>Name · you&rsquo;ll type it as {tag}</Mono>
          <input ref={nameField} value={name} onChange={(e) => setName(e.target.value)} placeholder="Rowan" aria-label="Name"
            className="box-border flex h-[52px] items-center rounded-card border border-[color:var(--gx-hover-border)] bg-card px-[14px] text-[20px] font-semibold leading-none text-ink outline-0 placeholder:text-ink-muted" />
        </label>
        <div className="flex flex-col gap-[6px]">
          <Mono>Kind</Mono>
          <span className="flex flex-wrap gap-[6px]" role="group" aria-label="Kind">
            {KIND_ORDER.map((k) => <button key={k} type="button" aria-pressed={k === kind} onClick={() => setKind(k)} className={`h-[44px] rounded-pill border px-[14px] text-[13.5px] font-medium leading-none ${k === kind ? "border-ink bg-ink text-ground" : "border-border-mid text-ink-body"}`}>{KIND_WORD[k]}</button>)}
          </span>
        </div>
        <div className="flex flex-col gap-[6px]">
          <Mono>References · {refs.length} · upload · a take · make · canvas</Mono>
          <div className="flex gap-[6px] overflow-x-auto rounded-card border border-dashed border-[color:var(--gx-hover-border)] p-[8px]" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}>
            <input ref={picker} type="file" accept="image/*,video/*,audio/*" multiple hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
            {refs.map((r, i) => (
              <span key={`${r.uploadId ?? r.genId}-${i}`} className="relative h-[64px] w-[64px] flex-none overflow-hidden rounded-ctl border border-[color:var(--gx-hair)] ui-placeholder">
                {r.url && r.kind === "image" && <img src={r.url} alt="" className="absolute inset-0 h-full w-full object-cover" />}
                {r.kind !== "image" && <span className="ui-mono absolute inset-0 flex items-center justify-center tracking-normal text-ink-body">{r.kind === "video" ? "Clip" : "Audio"}</span>}
                <button type="button" onClick={() => setRefs((p) => p.filter((_, k) => k !== i))} aria-label={`Remove ${r.label}`} className="ui-chip-scrim absolute right-[2px] top-[2px] rounded-badge px-[5px] py-[3px] text-[12px] leading-none text-ink">×</button>
              </span>
            ))}
            {uploading && <span className="flex h-[64px] w-[64px] flex-none items-center justify-center rounded-ctl border border-[color:var(--gx-hair)]"><Loader size={LOADER_SIZES.message} /></span>}
            <button type="button" onClick={() => setSourceMenu(true)} className="flex min-h-[64px] min-w-[64px] flex-1 items-center justify-center text-[13px] font-medium leading-none text-ink-body">+ Add</button>
          </div>
        </div>
        <div className="flex flex-col gap-[6px]">
          <Mono>What particl reads from these</Mono>
          <div className="grid grid-cols-2 gap-[6px]" role="list" aria-label="Ports">
            {ports.map((p) => (
              <span key={p.tag} role="listitem" className="flex items-center gap-[8px] rounded-tile border border-border bg-card px-[11px] py-[10px]">
                <span className="relative h-[26px] w-[34px] flex-none overflow-hidden rounded-[5px] border border-border bg-[color:var(--gx-input)] ui-placeholder">{p.state === "ready" && stills[0]?.url && <img src={stills[0].url} alt="" className="absolute inset-0 h-full w-full object-cover" />}</span>
                <span className="flex min-w-0 flex-col gap-[3px]"><span className="ui-mono text-ink">{p.tag}</span><span className={`ui-mono ui-mono-cost ${p.state === "ready" ? "text-accent" : p.state === "later" ? "text-ink-muted" : "text-ink-body"}`}>{p.state}</span></span>
              </span>
            ))}
          </div>
        </div>
        {trainRule !== "never" && (trainable
          ? <p className="rounded-card border border-border bg-card px-[14px] py-[12px] text-[13px] leading-[1.35] text-ink-body" data-train-where="">{TRAIN_FROM_CAST}</p>
          : <div className="flex items-center gap-[12px] rounded-card border border-border bg-card px-[14px] py-[12px]">
            <span className="flex min-w-0 flex-col gap-[4px]">
              <span className="text-[14px] font-medium leading-[1.2] text-ink">{trainLabel}</span>
              <span className="text-[12.5px] leading-[1.35] text-ink-body" style={{ textWrap: "pretty" }}>{trainNote}</span>
            </span>
            <button type="button" role="switch" aria-checked={false} aria-label={trainLabel} disabled
              className="relative ml-auto h-[32px] w-[52px] flex-none rounded-[16px] bg-[color:var(--gx-thumb)] disabled:opacity-40">
              <span className="absolute left-[3px] top-[3px] h-[26px] w-[26px] rounded-full bg-ink" />
            </button>
          </div>
        )}
      </Sheet>
      {sourceMenu && <Menu x={0} y={0} title="Pick from" items={sourceItems} onClose={() => setSourceMenu(false)} />}
      {takesMenu}
    </>
  );

  return (
    <div className="ui-sheet-scrim fixed inset-0 z-[60] flex items-center justify-center p-[16px]" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }} role="presentation">
      <div role="dialog" aria-modal="true" aria-label="New asset" className="flex max-h-full w-[760px] max-w-full flex-col overflow-hidden rounded-[16px] border border-border-mid bg-card">
        <div className="flex flex-none items-center gap-[12px] border-b border-border px-[20px] py-[16px]">
          <span className="text-[17px] font-semibold leading-none text-ink">New asset</span>
          <Mono className="max-md:hidden">Name · kind · references · that&rsquo;s it</Mono>
          <span className="ml-auto flex items-center gap-[6px]"><Mono>From</Mono><span className="rounded-pill border border-border-mid px-[8px] py-[5px] ui-mono text-ink">{FROM_LABEL[from]}</span></span>
          <button type="button" onClick={onClose} aria-label="Close" className="tap44 flex h-[32px] w-[32px] items-center justify-center rounded-ctl border border-border-mid text-[15px] leading-none text-ink">×</button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-[16px] px-[20px] pt-[18px] max-md:grid-cols-1">
            <label className="flex flex-col gap-[7px]">
              <Mono>Name · you&rsquo;ll type it as {tag}</Mono>
              <input ref={nameField} value={name} onChange={(e) => setName(e.target.value)} placeholder="Rowan" aria-label="Name"
                className="box-border h-[48px] rounded-tile border border-border-mid bg-ground px-[14px] text-[20px] font-semibold leading-none tracking-[-0.01em] text-ink outline-0 placeholder:text-ink-muted max-md:text-[16px]" />
            </label>
            <div className="flex flex-col gap-[7px]">
              <Mono>Kind</Mono>
              <span className="flex flex-wrap gap-[4px]" role="group" aria-label="Kind">
                {KIND_ORDER.map((k) => <button key={k} type="button" aria-pressed={k === kind} onClick={() => setKind(k)} className={kindBtn(k)}>{KIND_WORD[k]}</button>)}
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-[8px] px-[20px] pt-[16px]">
            <span className="flex items-baseline gap-[10px]"><Mono>References · {refs.length}</Mono><span className="text-[13px] leading-[1.3] text-ink-body">{refs.length ? "The first is the canonical still." : "Drop stills of the same thing; three to six is plenty."}</span></span>
            <div className="flex items-center gap-[8px] rounded-card border border-dashed border-[color:var(--gx-hover-border)] p-[10px] max-md:flex-wrap" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}>
              <input ref={picker} type="file" accept="image/*,video/*,audio/*" multiple hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
              {refs.slice(0, 6).map((r, i) => (
                <span key={`${r.uploadId ?? r.genId}-${i}`} className="relative h-[64px] w-[64px] flex-none overflow-hidden rounded-ctl border border-[color:var(--gx-card-border)] ui-placeholder">
                  {r.url && r.kind === "image" && <img src={r.url} alt="" className="absolute inset-0 h-full w-full object-cover" />}
                  {r.kind !== "image" && <span className="ui-mono absolute inset-0 flex items-center justify-center !text-[12px] tracking-normal text-ink-body">{r.kind === "video" ? "Clip" : "Audio"}</span>}
                  {i === 5 && refs.length > 6 && <span className="ui-mono absolute inset-0 flex items-center justify-center bg-[color:var(--gx-on-media)] !text-[12px] tracking-normal text-ink-body">+{refs.length - 5}</span>}
                  <button type="button" onClick={() => setRefs((p) => p.filter((_, k) => k !== i))} aria-label={`Remove ${r.label}`} className="ui-chip-scrim absolute right-[2px] top-[2px] rounded-badge px-[4px] py-[2px] text-[10px] leading-none text-ink">×</button>
                </span>
              ))}
              {uploading && <span className="flex h-[64px] w-[64px] flex-none items-center justify-center rounded-ctl border border-[color:var(--gx-card-border)]"><Loader size={LOADER_SIZES.message} /></span>}
              <span className="ml-auto flex flex-none flex-col items-end gap-[6px]">
                <span className="whitespace-nowrap text-[12.5px] leading-[1.3] text-ink-body">Drop more, or pick from</span>
                <span className="flex gap-[4px]">
                  <button type="button" className={source} onClick={() => picker.current?.click()}>Upload</button>
                  <button type="button" className={source} onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setTakeMenu({ x: r.left, y: r.bottom + 6 }); }}>A take</button>
                  <button type="button" className={source} onClick={() => { onClose(); router.push("/make/images"); }}>Make</button>
                  <button type="button" className={source} onClick={() => { if (!current) { toast("Pick a project first — Canvas belongs to a project."); return; } onClose(); router.push(`/rig/canvas/new?project=${encodeURIComponent(current.id)}`); }}>Canvas</button>
                </span>
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-[8px] px-[20px] pt-[16px]">
            <span className="flex items-baseline gap-[10px]"><Mono>What particl reads from these</Mono><span className="text-[13px] leading-[1.3] text-ink-body">Each becomes a port in Rig. Nothing here costs anything.</span></span>
            <div className="grid grid-cols-4 gap-[8px] max-md:grid-cols-2" role="list" aria-label="Ports">
              {ports.map((p) => (
                <div key={p.tag} role="listitem" className={`flex flex-col gap-[8px] rounded-tile border border-[color:var(--gx-card-border)] bg-ground p-[8px] ${p.state === "optional" ? "opacity-60" : p.state === "later" ? "opacity-80" : ""}`}>
                  <span className="relative h-[56px] rounded-[6px] border border-border ui-placeholder">
                    {p.state === "ready" && stills[0]?.url && <img src={stills[0].url} alt="" className="absolute inset-0 h-full w-full rounded-[6px] object-cover" />}
                    <span className="ui-chip-scrim absolute left-[5px] top-[5px] rounded-badge px-[5px] py-[4px]"><span className="ui-mono text-ink">{p.tag}</span></span>
                  </span>
                  <span className="flex flex-col gap-[4px]">
                    <span className={`flex items-center gap-[6px] ui-mono ${p.state === "ready" ? "text-ink" : "text-ink-muted"}`}>
                      <span className={`box-border block h-[7px] w-[7px] rounded-full ${p.state === "ready" ? "bg-ink" : p.state === "later" ? "border-[1.5px] border-dashed border-ink-muted" : "border border-ink-muted"}`} />{p.state}
                    </span>
                    <span className="text-[12.5px] leading-[1.3] text-ink-body">{p.note}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
          {trainRule !== "never" && (trainable
            ? <p className="mx-[20px] mt-[16px] rounded-card border border-[color:var(--gx-card-border)] bg-ground px-[14px] py-[12px] text-[13px] leading-[1.4] text-ink-body" data-train-where="">{TRAIN_FROM_CAST}</p>
            : <div className="mx-[20px] mt-[16px] flex items-center gap-[14px] rounded-card border border-[color:var(--gx-card-border)] bg-ground px-[14px] py-[12px] max-md:flex-wrap">
            <button type="button" role="switch" aria-checked={false} aria-label={trainLabel} disabled
              className="tap44 relative h-[20px] w-[36px] flex-none rounded-[10px] bg-[color:var(--gx-thumb)] disabled:opacity-40">
              <span className="absolute left-[2px] top-[2px] h-[16px] w-[16px] rounded-full bg-ink" />
            </button>
            <span className="flex min-w-0 flex-col gap-[4px]">
              <span className="text-[14px] font-medium leading-[1.2] text-ink">{trainLabel}</span>
              <span className="text-[13px] leading-[1.4] text-ink-body" style={{ textWrap: "pretty" }}>{trainNote}</span>
            </span>
            <Mono cost tone="ink" className="ml-auto flex-none whitespace-nowrap">—</Mono>
          </div>)}
        </div>
        <div className="flex flex-none items-center gap-[12px] px-[20px] pb-[20px] pt-[16px] max-md:flex-wrap">
          <Mono className="max-w-[380px] !leading-[1.5]">{note}</Mono>
          <span className="ml-auto flex gap-[8px]">
            <button type="button" onClick={onClose} className="h-[46px] rounded-card border border-border-mid px-[14px] text-[14px] font-medium leading-none text-ink">Cancel</button>
            <button type="button" onClick={create} disabled={busy || !signedIn} className="flex h-[46px] items-center gap-[12px] rounded-card bg-action hover:bg-action-hover px-[16px] text-[14px] font-semibold leading-none text-on-action disabled:opacity-60" data-create="">
              {busy ? <Loader size={LOADER_SIZES.button} on="primary" /> : null}Create {name.trim() || "asset"}<span className="ui-mono ui-mono-cost text-on-primary-cost">{shownPrice}</span>
            </button>
          </span>
        </div>
      </div>
      {takesMenu}
    </div>
  );
}
