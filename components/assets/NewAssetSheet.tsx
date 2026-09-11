"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useMoney } from "@/lib/price";
import { useProject } from "@/lib/projectContext";
import { uploadFile } from "@/lib/uploadClient";
import type { ElementKind } from "@/lib/rig";
import type { Generation } from "@/lib/jobs";
import { Mono } from "@/components/ui";
import Menu, { type MenuItem } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import Loader, { LOADER_SIZES } from "@/components/atomik/Loader";

/**
 * The New asset sheet (design/particl-v2/README.md §12; boards 3a, 3b):
 * one sheet, opened from the Library, Rig, a take, a Canvas selection, an
 * unknown `@name` in a prompt, or Atomik.
 *
 * Board 3a, value for value: a 760px card (`--card`, .14, radius 16) over
 * the `rgba(5,6,8,.55)` scrim. The header (`16px 20px`, .08): `New asset`
 * at 600 17, `NAME · KIND · REFERENCES · THAT'S IT`, `FROM <where>` and the
 * 32px close. Row 1: the name (a 48px field on ground, .14, radius 10, 600
 * 20, under `NAME · YOU'LL TYPE IT AS @IVER`) and the kind (48px buttons,
 * radius 10, `0 14px`, 500 13.5). Row 2: the references well (dashed .22,
 * radius 12, 10px; 64px thumbs; `Drop more, or pick from` `Upload · A take
 * · Make · Canvas`). Row 3: `WHAT PARTICL READS FROM THESE` — one tile per
 * derived port (ground, .1, radius 10, 8px; a 56px well with its tag; the
 * state dot and word; a line) with `READY / LATER / OPTIONAL`. Row 4: the
 * train switch (ground, .1, radius 12, `12px 14px`; a 36×20 switch) with
 * its price. The foot: the mono consequence line, `Cancel` (46px, .14,
 * radius 12), and the primary `Create Iver · 12 CR` (46px, radius 12).
 *
 * Rules (§12): creating is free; learning costs; attributes are read from
 * references, never typed. A character exists the moment it has a name and
 * one picture. The face is the one thing that trains today — on the
 * workspace's identity trainer, at its price, with consent on record — so
 * the switch is real for a character and says so for the kinds whose
 * engine is not connected yet.
 */
export type SheetFrom = "library" | "rig" | "take" | "canvas" | "prompt" | "atomik";
export type SheetRef = { uploadId?: string | null; genId?: string | null; url: string | null; label: string; kind: "image" | "video" | "audio" };
export type Created = { id: string; name: string; kind: ElementKind };

const FROM_LABEL: Record<SheetFrom, string> = { library: "Library", rig: "Rig · Canvas", take: "A take", canvas: "Canvas · selection", prompt: "A prompt", atomik: "Atomik" };
const KIND_WORD: Record<ElementKind, string> = { character: "Character", prop: "Prop", location: "Location", look: "Look", voice: "Voice" };
/** The order §12 lists them in: Character · Prop · Location · Look · Voice. */
const KIND_ORDER: ElementKind[] = ["character", "prop", "location", "look", "voice"];
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
  return props.open ? <SheetBody {...props} /> : null;
}

function SheetBody({ onClose, from, initial, onCreated }: SheetProps) {
  const router = useRouter();
  const { signedIn } = useSession();
  const { current } = useProject();
  const money = useMoney();
  const toast = useToast();
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<ElementKind>(initial?.kind ?? "character");
  const [refs, setRefs] = useState<SheetRef[]>(initial?.references ?? []);
  const [train, setTrain] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [takeMenu, setTakeMenu] = useState<{ x: number; y: number } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const { data: terms } = useApi<{ terms: { configured: boolean; minPhotos: number; trainCostUsd: number } }>(signedIn ? "/api/identities" : null, 0);
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
  const trainable = kind === "character";
  const trainCost = trainable && terms?.terms.trainCostUsd != null ? terms.terms.trainCostUsd : null;
  const enoughPhotos = stills.length >= (terms?.terms.minPhotos ?? 5);
  const trainOn = trainable && train && enoughPhotos && consent && Boolean(terms?.terms.configured);
  const cost = trainOn && trainCost != null ? trainCost : 0;
  const trainLabel = kind === "character" ? "Train the face now" : kind === "prop" ? "Make a turntable later" : kind === "location" ? "Fill the missing hour later" : kind === "look" ? "Apply to existing keyframes later" : "Train the voice later";
  const trainNote = kind === "character"
    ? (!terms?.terms.configured ? "No trainer is connected to this workspace yet." : !enoughPhotos ? `Needs ${terms?.terms.minPhotos ?? 5} stills of the same person; ${stills.length} so far. Off, the character carries a still and trains later in Rig.` : "A likeness that holds across shots. Off, the character carries a still and trains later in Rig.")
    : "No engine is connected for this yet. It will be priced from the engine when one is, from Rig.";
  const note = trainOn
    ? `Creates ${tag} · trains the face now · ${money.price(cost)} · renders with the still while it trains`
    : `Creates ${tag} with ${stills.length ? "a still" : "no picture yet"} · ${trainable ? "train the face later in Rig" : "attributes read from the references"} · 0 CR`;

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).slice(0, 12);
    if (!list.length) return;
    setUploading(true);
    try {
      for (const f of list) {
        const up = await uploadFile(f, "reference");
        setRefs((prev) => prev.some((r) => r.uploadId === up.id) ? prev : [...prev, { uploadId: up.id, url: up.url, label: up.filename, kind: up.kind === "video" ? "video" : up.kind === "file" ? "audio" : "image" }]);
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
      let identityId: string | null = null;
      if (trainOn) {
        /* A trained face is an identity: the trainer's own table, with consent on record. */
        const r = await fetch("/api/identities", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: clean, description: initial?.description ?? "", photos: stills.map((s) => s.uploadId).filter(Boolean), projectId: null }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? "The identity wasn't made.");
        identityId = j.identity?.id ?? null;
        const t = await fetch(`/api/identities/${identityId}/train`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ consent: true }) });
        const tj = await t.json().catch(() => ({}));
        if (!t.ok) throw new Error(tj.error ?? "Training didn't start.");
      } else if (CAST_KIND[kind]) {
        /* A name the prompt can cite, carrying its still. */
        const r = await fetch("/api/cast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: clean, kind: CAST_KIND[kind], description: initial?.description ?? "", uploadId: stills[0]?.uploadId ?? null }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok && r.status !== 409) throw new Error(j.error ?? "The name wasn't added to the cast.");
        castId = j.member?.id ?? null;
      }
      const first = refs[0];
      const r = await fetch("/api/rig/elements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        name: clean, kind, description: initial?.description ?? "", castId, identityId,
        fromUploadId: first?.uploadId ?? null, fromGenId: first?.genId ?? null,
        references: refs.map((x) => ({ uploadId: x.uploadId ?? null, genId: x.genId ?? null })),
      }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "The asset wasn't created.");
      toast(`${tag} created · ${trainOn ? `${money.price(cost)} · the face is training` : "0 CR"}`);
      onCreated?.({ id: j.element.id, name: j.element.name, kind });
      onClose();
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };

  const kindBtn = (k: ElementKind) => `tap44 h-[48px] rounded-tile border px-[14px] text-[13.5px] font-medium leading-none ${k === kind ? "border-[rgba(245,246,248,.3)] bg-[rgba(245,246,248,.12)] text-ink" : "border-[rgba(245,246,248,.12)] text-ink-body"}`;
  const source = "tap44 whitespace-nowrap rounded-pill border border-border-mid px-[9px] py-[7px] text-[12px] font-medium leading-none text-ink";

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
              <input ref={nameField} value={name} onChange={(e) => setName(e.target.value)} placeholder="Iver" aria-label="Name"
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
            <div className="flex items-center gap-[8px] rounded-card border border-dashed border-[rgba(245,246,248,.22)] p-[10px] max-md:flex-wrap" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}>
              <input ref={picker} type="file" accept="image/*,video/*,audio/*" multiple hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
              {refs.slice(0, 6).map((r, i) => (
                <span key={`${r.uploadId ?? r.genId}-${i}`} className="relative h-[64px] w-[64px] flex-none overflow-hidden rounded-ctl border border-[rgba(245,246,248,.1)] ui-placeholder">
                  {r.url && r.kind === "image" && <img src={r.url} alt="" className="absolute inset-0 h-full w-full object-cover" />}
                  {r.kind !== "image" && <span className="ui-mono absolute inset-0 flex items-center justify-center !text-[12px] tracking-normal text-ink-body">{r.kind === "video" ? "Clip" : "Audio"}</span>}
                  {i === 5 && refs.length > 6 && <span className="ui-mono absolute inset-0 flex items-center justify-center bg-[rgba(11,13,17,.7)] !text-[12px] tracking-normal text-ink-body">+{refs.length - 5}</span>}
                  <button type="button" onClick={() => setRefs((p) => p.filter((_, k) => k !== i))} aria-label={`Remove ${r.label}`} className="ui-chip-scrim absolute right-[2px] top-[2px] rounded-badge px-[4px] py-[2px] text-[10px] leading-none text-ink">×</button>
                </span>
              ))}
              {uploading && <span className="flex h-[64px] w-[64px] flex-none items-center justify-center rounded-ctl border border-[rgba(245,246,248,.1)]"><Loader size={LOADER_SIZES.message} /></span>}
              <span className="ml-auto flex flex-none flex-col items-end gap-[6px]">
                <span className="whitespace-nowrap text-[12.5px] leading-[1.3] text-ink-body">Drop more, or pick from</span>
                <span className="flex gap-[4px]">
                  <button type="button" className={source} onClick={() => picker.current?.click()}>Upload</button>
                  <button type="button" className={source} onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setTakeMenu({ x: r.left, y: r.bottom + 6 }); }}>A take</button>
                  <button type="button" className={source} onClick={() => { onClose(); router.push("/make/images"); }}>Make</button>
                  <button type="button" className={source} onClick={() => { if (!current) { toast("Pick a production first — Canvas belongs to a project."); return; } onClose(); router.push(`/rig/canvas/new?project=${encodeURIComponent(current.id)}`); }}>Canvas</button>
                </span>
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-[8px] px-[20px] pt-[16px]">
            <span className="flex items-baseline gap-[10px]"><Mono>What particl reads from these</Mono><span className="text-[13px] leading-[1.3] text-ink-body">Each becomes a port in Rig. Nothing here costs anything.</span></span>
            <div className="grid grid-cols-4 gap-[8px] max-md:grid-cols-2" role="list" aria-label="Ports">
              {ports.map((p) => (
                <div key={p.tag} role="listitem" className={`flex flex-col gap-[8px] rounded-tile border border-[rgba(245,246,248,.1)] bg-ground p-[8px] ${p.state === "optional" ? "opacity-60" : p.state === "later" ? "opacity-80" : ""}`}>
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
          <div className="mx-[20px] mt-[16px] flex items-center gap-[14px] rounded-card border border-[rgba(245,246,248,.1)] bg-ground px-[14px] py-[12px] max-md:flex-wrap">
            <button type="button" role="switch" aria-checked={trainable && train} aria-label={trainLabel} disabled={!trainable || !terms?.terms.configured} onClick={() => setTrain((t) => !t)}
              className={`tap44 relative h-[20px] w-[36px] flex-none rounded-[10px] disabled:opacity-40 ${trainable && train ? "bg-ink" : "bg-[rgba(245,246,248,.2)]"}`}>
              <span className={`absolute top-[2px] h-[16px] w-[16px] rounded-full ${trainable && train ? "left-[18px] bg-ground" : "left-[2px] bg-ink"}`} />
            </button>
            <span className="flex min-w-0 flex-col gap-[4px]">
              <span className="text-[14px] font-medium leading-[1.2] text-ink">{trainLabel}</span>
              <span className="text-[13px] leading-[1.4] text-ink-body" style={{ textWrap: "pretty" }}>{trainNote}</span>
              {trainable && train && enoughPhotos && terms?.terms.configured && (
                <label className="mt-[4px] flex items-start gap-[8px] text-[13px] leading-[1.4] text-ink"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} aria-label="Consent to train" className="mt-[3px]" />I have the right to train on this person&rsquo;s face.</label>
              )}
            </span>
            <Mono cost tone="ink" className="ml-auto flex-none whitespace-nowrap">{trainable && trainCost != null ? money.price(trainCost) : "—"}</Mono>
          </div>
        </div>
        <div className="flex flex-none items-center gap-[12px] px-[20px] pb-[20px] pt-[16px] max-md:flex-wrap">
          <Mono className="max-w-[380px] !leading-[1.5]">{note}</Mono>
          <span className="ml-auto flex gap-[8px]">
            <button type="button" onClick={onClose} className="h-[46px] rounded-card border border-border-mid px-[14px] text-[14px] font-medium leading-none text-ink">Cancel</button>
            <button type="button" onClick={create} disabled={busy || !signedIn} className="flex h-[46px] items-center gap-[12px] rounded-card bg-ink px-[16px] text-[14px] font-semibold leading-none text-ground disabled:opacity-60" data-create="">
              {busy ? <Loader size={LOADER_SIZES.button} on="primary" /> : null}Create {name.trim() || "asset"}<span className="ui-mono ui-mono-cost text-on-primary-cost">{money.price(cost)}</span>
            </button>
          </span>
        </div>
      </div>
      {takeMenu && <Menu x={takeMenu.x} y={takeMenu.y} title="A take · the newest stills" items={takeItems.length ? takeItems : [{ kind: "note", text: takes ? "No finished stills yet." : "Loading…" }]} onClose={() => setTakeMenu(null)} />}
    </div>
  );
}
