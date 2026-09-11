"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as RMouseEvent } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useSession, useSignInHref } from "@/lib/session";
import { useMoney } from "@/lib/price";
import { MODELS, DEFAULT_MODEL_ID, getModel, estimateTokens, costUsd } from "@/lib/models";
import { estimateVideo, estimateImage } from "@/lib/rateTable";
import { COUNTS, newBatchId } from "@/lib/variations";
import { CATEGORIES, composePrompt, detectSpec, type ShotSpec } from "@/lib/studio";
import { loadDraft, saveDraft, clearDraft } from "@/lib/draft";
import { uploadFile } from "@/lib/uploadClient";
import { ROLE_LABEL, type RefItem, type ImageRole } from "@/lib/refs";
import type { CastMember } from "@/lib/cast";
import { appPrompt } from "@/components/dialog";
import { Button, Mono, Segmented, PinnedBar } from "@/components/ui";
import Sheet from "@/components/ui/Sheet";
import { usePhone } from "@/lib/usePhone";
import { useDropTarget, type DragPayload } from "@/lib/useDnd";
import { readDraggedAsset } from "@/lib/dnd";
import { getClip, consumeClip } from "@/lib/clipboard";
import Menu, { type MenuItem } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import { useAtomikRail } from "@/lib/atomikRail";
import NewAssetSheet from "@/components/assets/NewAssetSheet";
import type { ElementKind } from "@/lib/rig";

/**
 * The one composer (design/particl-v2/README.md §10; board 8a), identical
 * everywhere it appears: Make's right rail today, a shot's sheet tomorrow.
 *
 * Board 8a, value for value: a 52px header (`Composer` 600 15, `UNFILED ·
 * FILE LATER`); the prompt (`--card`, .14, radius 12, `12px 13px`, 104
 * high, 400 14.5/1.5, `@Name` on a .1 fill); the reference row (`+ Ref`
 * 52px dashed .22, the FRAME thumb, `first frame · optional`); the model
 * chip (`--card`, .35, radius 10, `10px 12px`: the name at 500 13.5, its
 * one-line "what it's for" at 400 12, the rate in mono — `19 CR / 5S`)
 * that opens into the list (radius 10, .14, 4px padding; rows `9px 10px`
 * with a 14px ring); the pills (`9px 11px`, .1 on `--card`: `16:9 ▼`,
 * `5s ▼`, `×1 ▼`, `1080P`, `Audio` with its 22×12 switch); `Setup` with its
 * rows as `6px 9px` chips and `+ Row`; `Cast` with its `@Name` chips and
 * `+ Add`; and the foot — the one filled primary, `Render · 19 CR · 5S ·
 * 1080P` (48px, radius 12), over `LANDS ON THE WALL UNFILED · FILE TO A
 * SHOT ANY TIME`.
 *
 * Images swap the duration for the resolution, keep the reference well and
 * add Loose / Exact. Audio is the script, the track kind, the voice picker
 * with a sample to play, the language, and a duration readout.
 *
 * Every price is read from the workspace's rate table for the chosen engine
 * and settings (§1: never typed), and the button says it before the press.
 * Everything made here lands unfiled (§1) — no project, no shot — until
 * `File to shot` on the wall.
 *
 * Below 768 (design/particl-v2-mobile, boards M4 and M9) the same composer
 * docks: a card above the pinned `Render` — `COMPOSER · SEEDANCE 2.5 ·
 * 16:9 · 5S` in mono, the prompt's first line, `↑` — that opens the sheet
 * (60px below the top; a 44px header, `Composer` 600 15 and `VIDEO ·
 * UNFILED`): the prompt at 96px, the 3b card, `+ REF` at 56 with its
 * note, the model card (600 14, one line, `19 CR / 5S ▾`), the pills at
 * 40px (`0 13px`), `SETUP · NONE CARRIED · UNFILED` with `+ ROW`, `CAST`
 * with 40px chips (a 26px face; `@Iver · new` dashed) and `+ Add`; the
 * foot pins Render at 52px over its mono line. The prompt and every
 * setting are the same state whether the sheet is open or closed.
 */
export type ComposerKind = "video" | "image" | "audio";
const WELL_ACCEPTS: DragPayload["kind"][] = ["media", "reference"];

type Voice = { id: string; name: string; category: string; labels: Record<string, string>; previewUrl: string | null; description: string };
type SpeechModel = { id: string; label: string; creditsPerChar: number; note: string; alpha?: boolean };
type AudioSetup = {
  configured: boolean; speechModels: SpeechModel[]; defaultSpeechModel: string;
  voices: Voice[]; voicesError: string | null;
  account: { usdPerCredit: number } | null;
  terms: { sfxCredits: number; musicCreditsPerMinute: number };
};
type Track = "sound" | "music" | "speech";
const TRACKS: { id: Track; label: string; placeholder: string }[] = [
  { id: "sound", label: "Ambient", placeholder: "Rain on a corrugated roof, steady, close. A single fluorescent tube humming. Far off, a road. No music." },
  { id: "music", label: "Music", placeholder: "Slow cinematic strings building to a brass swell, 90 bpm, hopeful, no vocals." },
  { id: "speech", label: "Dialogue", placeholder: "The line, as it should be read. Direct it inline: [whispers] we shouldn't be here." },
];

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

/** `@Name` tokens in a prompt, the way the composer highlights and the engine reads them. */
const NAME_RE = /@([A-Za-z][\w'-]*(?: (?=[A-Z])[A-Z][\w'-]*)*)/g;

export default function Composer({ kind, onMade, initialRef = null, className = "" }: { kind: ComposerKind; onMade?: () => void; initialRef?: string | null; className?: string }) {
  const router = useRouter();
  const phone = usePhone();
  const [sheetOpen, setSheetOpen] = useState(false);
  const { signedIn, rates } = useSession();
  const signIn = useSignInHref();
  const money = useMoney();
  const toast = useToast();
  const rail = useAtomikRail();
  const surface = `make:${kind}`;

  /* ── the words ─────────────────────────────────────────────────────── */
  const [prompt, setPromptState] = useState(() => loadDraft(surface, signedIn));
  const setPrompt = useCallback((v: string) => { setPromptState(v); saveDraft(surface, v); }, [surface]);
  const field = useRef<HTMLTextAreaElement>(null);
  const insertAtCaret = (token: string) => {
    const el = field.current;
    const at = el?.selectionStart ?? prompt.length;
    const before = prompt.slice(0, at), after = prompt.slice(at);
    const sp = before && !/\s$/.test(before) ? " " : "";
    const next = `${before}${sp}${token} ${after}`;
    setPrompt(next);
    requestAnimationFrame(() => { el?.focus(); const p = (before + sp + token + " ").length; el?.setSelectionRange(p, p); });
  };

  /* ── references ────────────────────────────────────────────────────── */
  const [refs, setRefs] = useState<RefItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).slice(0, 8);
    if (!list.length) return;
    setUploading(true);
    try {
      for (const f of list) {
        const up = await uploadFile(f, "reference");
        const role: ImageRole = up.kind === "video" ? "reference_video" : kind === "video" && !refs.some((r) => r.role === "first_frame") ? "first_frame" : "reference_image";
        setRefs((prev) => prev.some((r) => r.id === up.id) ? prev : [...prev, { ...up, kind: up.kind === "video" ? "video" : "image", base64Bytes: up.base64Bytes ?? 0, role, verified: true }]);
      }
    } catch (e) { toast((e as Error).message); }
    finally { setUploading(false); }
  };
  /* CR1 §11 / §10: a take or a reference dropped on the well, or pasted with ⌘V, becomes a reference — a take by its id, a reference by its upload. */
  const addFromPayload = useCallback((p: { kind: "media" | "reference"; id: string; label: string; url?: string | null; data?: unknown }) => {
    const mediaKind = (p.data as { kind?: string } | undefined)?.kind === "video" ? "video" : "image";
    const role: ImageRole = mediaKind === "video" ? "reference_video" : kind === "video" && !refs.some((r) => r.role === "first_frame") ? "first_frame" : "reference_image";
    setRefs((prev) => prev.some((r) => r.id === p.id) ? prev : [...prev, { id: p.id, filename: p.label, mime: mediaKind === "video" ? "video/mp4" : "image/*", kind: mediaKind, bytes: 0, width: null, height: null, durationS: null, sha256: "", url: p.url ?? "", base64Bytes: 0, role, verified: true, genId: p.kind === "media" ? p.id : undefined }]);
    toast(`${p.label} · in the well as ${ROLE_LABEL[role].toLowerCase()}`);
  }, [kind, refs, toast]);
  const well = useDropTarget(WELL_ACCEPTS, (p) => { if (p.kind === "media" || p.kind === "reference") addFromPayload(p as { kind: "media" | "reference"; id: string; label: string; url?: string | null; data?: unknown }); });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "v") return;
      const c = getClip();
      if (!c || (c.kind !== "media" && c.kind !== "reference")) return;
      e.preventDefault();
      addFromPayload({ kind: c.kind, id: c.id, label: c.label, url: (c.payload as { url?: string | null } | undefined)?.url ?? null, data: c.payload });
      if (c.mode === "cut") consumeClip();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [addFromPayload]);
  const seededRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialRef || !signedIn || seededRef.current === initialRef) return;
    seededRef.current = initialRef;
    fetch(`/api/uploads?limit=500`).then((r) => r.json()).then((j) => {
      const u = (j.uploads as { id: string; filename: string; mime: string; bytes: number; width: number | null; height: number | null; kind: "image" | "video"; durationS: number | null; url: string }[] | undefined)?.find((x) => x.id === initialRef);
      if (u) setRefs((prev) => prev.some((r) => r.id === u.id) ? prev : [...prev, { ...u, sha256: "", base64Bytes: 0, role: u.kind === "video" ? "reference_video" : kind === "video" ? "first_frame" : "reference_image", verified: true }]);
    }).catch(() => {});
  }, [initialRef, signedIn, kind]);
  const [useAs, setUseAs] = useState<"loose" | "first">("loose");

  /* ── the engine and its settings (§1: read from the engine, never typed) ── */
  const choices = useMemo(() => MODELS.filter((m) => m.kind === (kind === "image" ? "image" : "video") && !m.hidden && (kind !== "video" || m.durations.length > 0)), [kind]);
  const [modelId, setModelId] = useState<string>(() => kind === "image" ? (MODELS.find((m) => m.kind === "image" && !m.hidden)?.id ?? DEFAULT_MODEL_ID) : DEFAULT_MODEL_ID);
  const model = getModel(modelId);
  const [listOpen, setListOpen] = useState(false);
  const [ratio, setRatio] = useState<string>(() => (model.ratios.includes("16:9") ? "16:9" : model.ratios[0]));
  const [seconds, setSeconds] = useState<number>(() => (model.durations.includes(5) ? 5 : model.durations[0] ?? 5));
  const [resolution, setResolution] = useState<string>(() => (model.resolutions.includes("1080p") ? "1080p" : model.resolutions.includes("1K") ? "1K" : model.resolutions[0]));
  const [count, setCount] = useState(1);
  const [audio, setAudio] = useState(true);
  const pickModel = (id: string) => {
    const m = getModel(id);
    setModelId(id); setListOpen(false);
    if (!m.ratios.includes(ratio)) setRatio(m.ratios.includes("16:9") ? "16:9" : m.ratios[0]);
    if (m.kind === "video" && !m.durations.includes(seconds)) setSeconds(m.durations.includes(5) ? 5 : m.durations[0] ?? 5);
    if (!m.resolutions.includes(resolution)) setResolution(m.resolutions.includes("1080p") ? "1080p" : m.resolutions.includes("1K") ? "1K" : m.resolutions[0]);
  };
  const [menu, setMenu] = useState<{ which: "ratio" | "seconds" | "count" | "resolution" | "setup" | "length" | "duration"; x: number; y: number } | null>(null);
  const [openCat, setOpenCat] = useState<string | null>(null);
  const at = (e: RMouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return { x: r.left, y: r.bottom + 6 }; };

  /** The price of one press for this engine at these settings, in the table's unit. */
  const priceOf = useCallback((mId: string, res: string, secs: number, withAudio: boolean, refsIn: number): number | null => {
    const m = getModel(mId);
    if (m.kind === "image") return estimateImage(rates, mId, res, refsIn);
    return estimateVideo(rates, mId, res, secs, estimateTokens(res, ratio, secs), costUsd, { audio: withAudio && m.supportsAudio });
  }, [rates, ratio]);
  const unit = priceOf(modelId, resolution, seconds, audio, refs.filter((r) => r.kind === "image").length);
  const price = unit == null ? null : unit * count;
  /** `19 CR / 5S` on a video chip; `3 CR / STILL` on an image chip. */
  const rateLine = (mId: string) => {
    const m = getModel(mId);
    const p = priceOf(mId, m.kind === "image" ? (m.resolutions.includes(resolution) ? resolution : m.resolutions[0]) : (m.resolutions.includes(resolution) ? resolution : m.resolutions[0]), m.kind === "image" ? 0 : (m.durations.includes(seconds) ? seconds : 5), audio, 0);
    return p == null ? "—" : `${money.price(p)} / ${m.kind === "image" ? "still" : `${m.durations.includes(seconds) ? seconds : 5}s`}`;
  };

  /* ── setup rows and cast (§10) ─────────────────────────────────────── */
  const [spec, setSpec] = useState<ShotSpec>({});
  const detected = useMemo(() => detectSpec(prompt), [prompt]);
  const rows = CATEGORIES.map((c) => ({ c, value: spec[c.key] ?? null })).filter((r) => r.value);
  const setRow = (key: string, value: string | null) => setSpec((s) => ({ ...s, [key]: value }));
  const { data: castData, refresh: refreshCast } = useApi<{ cast: CastMember[] }>(signedIn && kind !== "audio" ? "/api/cast?projectId=all" : null, 0);
  const cast = useMemo(() => castData?.cast ?? [], [castData]);
  const { data: elsData, refresh: refreshEls } = useApi<{ elements: { name: string }[] }>(signedIn && kind !== "audio" ? "/api/rig/elements" : null, 60_000);
  const { data: idTerms } = useApi<{ terms: { trainCostUsd: number } }>(signedIn && kind !== "audio" ? "/api/identities" : null, 0);
  /* 3b: a name the prompt cites that nobody has made yet. */
  const known = useMemo(() => new Set([...cast.map((m) => m.name.toLowerCase()), ...(elsData?.elements ?? []).map((e) => e.name.toLowerCase())]), [cast, elsData]);
  const unknown = useMemo(() => kind === "audio" || !signedIn ? [] : [...new Set([...prompt.matchAll(NAME_RE)].map((m) => m[1]).filter((n) => !known.has(n.toLowerCase())))], [prompt, known, kind, signedIn]);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [sheetKind, setSheetKind] = useState<ElementKind>("character");
  const [pickFor, setPickFor] = useState<{ name: string; x: number; y: number } | null>(null);
  const replaceName = (from: string, to: string) => setPrompt(prompt.replace(new RegExp(`@${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w'-])`, "g"), `@${to}`));
  const addCast = async () => {
    const name = await appPrompt("New cast member", "", "@Name", "Type the name the prompt will cite — you'll write it as @Name.");
    if (!name?.trim()) return;
    const r = await fetch("/api/cast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.replace(/^@/, "").trim() }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error ?? "Not added."); return; }
    refreshCast(); insertAtCaret(`@${j.member?.name ?? name.replace(/^@/, "").trim()}`);
  };

  /* ── audio (§10: script, kind, voice with a sample, language, duration) ── */
  const { data: audioSetup } = useApi<AudioSetup>(kind === "audio" && signedIn ? "/api/audio" : null, 0);
  const [track, setTrack] = useState<Track>("speech");
  const [voiceId, setVoiceId] = useState("");
  const [voiceQuery, setVoiceQuery] = useState("");
  const [speechModel, setSpeechModel] = useState("");
  const [lengthS, setLengthS] = useState(30);
  const [sfxS, setSfxS] = useState<number | null>(null);
  const [instrumental, setInstrumental] = useState(true);
  const sample = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const voices = useMemo(() => audioSetup?.voices ?? [], [audioSetup]);
  const voice = voices.find((v) => v.id === (voiceId || voices[0]?.id)) ?? null;
  const shownVoices = useMemo(() => { const q = voiceQuery.trim().toLowerCase(); return q ? voices.filter((v) => `${v.name} ${Object.values(v.labels).join(" ")} ${v.description}`.toLowerCase().includes(q)) : voices; }, [voices, voiceQuery]);
  const sModel = (audioSetup?.speechModels ?? []).find((m) => m.id === (speechModel || audioSetup?.defaultSpeechModel)) ?? audioSetup?.speechModels[0] ?? null;
  const spokenS = Math.max(1, Math.round(words(prompt) / 2.5));
  const audioLen = track === "speech" ? spokenS : track === "music" ? lengthS : (sfxS ?? Math.min(30, Math.max(3, spokenS)));
  const audioCredits = track === "speech" ? Math.ceil(prompt.length * (sModel?.creditsPerChar ?? 1)) : track === "sound" ? (audioSetup?.terms.sfxCredits ?? 200) : Math.ceil((lengthS / 60) * (audioSetup?.terms.musicCreditsPerMinute ?? 900));
  const audioUsd = audioCredits * (audioSetup?.account?.usdPerCredit ?? 22 / 121_000);
  const playSample = (v: Voice) => {
    if (!v.previewUrl) return;
    if (playing === v.id) { sample.current?.pause(); setPlaying(null); return; }
    sample.current?.pause();
    const a = new Audio(v.previewUrl); sample.current = a; setPlaying(v.id);
    a.onended = () => setPlaying(null); a.play().catch(() => setPlaying(null));
  };

  /* ── the press ─────────────────────────────────────────────────────── */
  const [busy, setBusy] = useState(false);
  const ready = prompt.trim().length > 0 && !uploading && (kind !== "audio" || (track !== "speech" || Boolean(voice)));
  const render = async () => {
    if (!signedIn) { router.push(signIn); return; }
    if (!ready || busy || unknown.length) return;
    setBusy(true);
    try {
      if (kind === "audio") {
        const body: Record<string, unknown> = { task: track, text: prompt, projectId: null, shotId: null, title: track === "speech" ? `${voice?.name ?? "Voice"} · ${prompt.trim().slice(0, 40)}` : prompt.trim().slice(0, 60) };
        if (track === "speech") Object.assign(body, { voiceId: voice?.id, voiceName: voice?.name, modelId: sModel?.id });
        if (track === "sound") Object.assign(body, { durationSeconds: sfxS });
        if (track === "music") Object.assign(body, { lengthMs: lengthS * 1000, instrumental });
        const r = await fetch("/api/audio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? "Couldn't start.");
        if (Array.isArray(j.notices) && j.notices.length) toast(j.notices.join(" · "));
      } else {
        const applied: ShotSpec = { ...detected, ...spec };
        const base = {
          prompt: composePrompt(prompt, applied), model: modelId, ratio, resolution, duration: seconds, generateAudio: audio && model.supportsAudio,
          projectId: null, shotId: null, task: "generate", shotSpec: applied,
          references: refs.map((r) => (r.genId ? { genId: r.genId, role: r.role } : { uploadId: r.id, role: r.role })),
          useAs: kind === "image" ? useAs : undefined,
        };
        const batchId = count > 1 ? newBatchId() : undefined;
        let reason: string | null = null;
        for (let i = 0; i < count; i++) {
          const body = batchId ? { ...base, batchId, variation: i + 1, count } : base;
          let r = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reason ? { ...body, reason } : body) });
          let j = await r.json().catch(() => ({}));
          if (r.status === 409 && j.needsReason) {
            const said = await appPrompt(j.error ?? "Why render another?", "", j.line ?? "");
            if (!said?.trim()) return;
            reason = said.trim();
            r = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, reason }) });
            j = await r.json().catch(() => ({}));
          }
          if (!r.ok) throw new Error(j.error ?? "Submit failed.");
          if (Array.isArray(j.notices) && j.notices.length) toast(j.notices.join(" · "));
        }
      }
      clearDraft(surface); setPromptState(""); setRefs([]);
      toast(`Rendering · ${money.price(kind === "audio" ? audioUsd : price ?? 0)} · lands on the wall unfiled`);
      onMade?.();
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && field.current === document.activeElement) { e.preventDefault(); render(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  /* ── the parts ─────────────────────────────────────────────────────── */
  const pill = phone
    ? "tap44 flex h-[40px] items-center gap-[8px] rounded-pill border border-[rgba(245,246,248,.12)] px-[13px] text-[13px] font-medium leading-none text-ink"
    : "tap44 flex items-center gap-[7px] rounded-pill border border-[rgba(245,246,248,.1)] bg-card px-[11px] py-[9px] text-[12.5px] font-medium leading-none text-ink";
  const caret = phone ? null : <span className="text-[9px] text-ink-muted max-md:text-[12px]">▼</span>;
  const frame = refs.find((r) => r.role === "first_frame") ?? null;
  const menuItems = (): MenuItem[] => {
    if (!menu) return [];
    if (menu.which === "ratio") return model.ratios.map((r) => ({ kind: "item", label: r, onSelect: () => setRatio(r) }));
    if (menu.which === "seconds") return model.durations.map((s) => ({ kind: "item", label: `${s}s`, onSelect: () => setSeconds(s) }));
    if (menu.which === "count") return COUNTS[model.kind].map((n) => ({ kind: "item", label: `×${n}`, onSelect: () => setCount(n) }));
    if (menu.which === "resolution") return model.resolutions.map((r) => ({ kind: "item", label: r.toUpperCase(), onSelect: () => setResolution(r) }));
    if (menu.which === "length") return [15, 30, 60, 120].map((s) => ({ kind: "item", label: mmss(s), onSelect: () => setLengthS(s) }));
    if (menu.which === "duration") return [null, 3, 5, 10, 20].map((s) => ({ kind: "item", label: s == null ? "Auto" : `${s}s`, onSelect: () => setSfxS(s) }));
    return CATEGORIES.map((c): MenuItem => ({ kind: "sub", label: c.label, open: openCat === c.key, onToggle: () => setOpenCat((k) => (k === c.key ? null : c.key)), items: c.options.map((o) => ({ label: o.label, onSelect: () => { setRow(c.key, o.value); setMenu(null); } })) }));
  };
  const suffix = kind === "audio" ? ` · ${mmss(audioLen)}` : kind === "image" ? ` · ${resolution.toUpperCase()}` : ` · ${seconds}s · ${resolution.toUpperCase()}`;
  const cost = kind === "audio" ? audioUsd : price ?? 0;
  /* M4's docked card: the engine and the settings in mono, the prompt's first line with its names marked. */
  const eyebrow = kind === "audio" ? `Composer · ${TRACKS.find((t) => t.id === track)!.label} · ${mmss(audioLen)}` : kind === "image" ? `Composer · ${model.label} · ${ratio} · ${resolution}` : `Composer · ${model.label} · ${ratio} · ${seconds}s`;
  const firstLine = prompt.split("\n").find((l) => l.trim()) ?? "";
  const blocked = unknown.length > 0 || (signedIn && !ready);
  const footLine = unknown.length ? `Create @${unknown[0]} first · lands on the wall unfiled` : "Lands on the wall unfiled · file to a shot any time";
  const primary = (tall: boolean) => (
    <button type="button" onClick={render} disabled={busy || (signedIn && (!ready || unknown.length > 0))} data-render=""
      className={`flex ${tall ? "h-[52px]" : "h-[50px]"} w-full items-center justify-between rounded-mobile px-[16px] text-[15px] font-semibold leading-none ${
        blocked || rail.open || (!tall && sheetOpen) ? "border border-[rgba(245,246,248,.2)] bg-transparent text-ink-body" : "bg-ink text-ground"}`}>
      <span>{busy ? "Rendering…" : signedIn ? "Render" : "Sign in to render"}</span>
      <span className={`ui-mono ui-mono-cost !text-[12px] ${blocked || rail.open || (!tall && sheetOpen) ? "text-ink-muted" : "text-on-primary-cost"}`}>{money.price(cost)}{suffix}</span>
    </button>
  );

  const body = (
      <>
        {kind === "audio" && (
          <Segmented label="Track kind" placement="bar" value={track} onChange={(t) => setTrack(t)} options={TRACKS.map((t) => ({ value: t.id, label: t.label }))} />
        )}
        <PromptField phone={phone} value={prompt} onChange={setPrompt} fieldRef={field} placeholder={kind === "audio" ? TRACKS.find((t) => t.id === track)!.placeholder : kind === "image" ? "A brass key on marble, dust in the light. @Noor's hand at the edge of frame." : "A hand turns a brass key in a door that is not there. Dust in the light. @Noor watches from the corridor."} names={kind !== "audio"} unknown={unknown} />
        {unknown.length > 0 && (() => { const nm = unknown[0]; const thumbs = refs.filter((r) => r.kind === "image").slice(0, 3); return (
          <div className={`flex flex-col gap-[10px] rounded-card border border-[rgba(245,246,248,.2)] px-[13px] py-[12px] ${phone ? "bg-card" : "bg-ground"}`} role="group" aria-label={`Not an asset yet: @${nm}`}>
            {phone ? <Mono>Not an asset yet · @{nm}</Mono> : <span className="flex items-center gap-[8px]"><Mono>Not an asset yet</Mono><span className="text-[15px] font-semibold leading-none text-ink">@{nm}</span></span>}
            <span className={`text-[13.5px] text-ink-body ${phone ? "leading-[1.4]" : "leading-[1.45]"}`} style={{ textWrap: "pretty" }}>{thumbs.length ? `Make one from the ${thumbs.length === 1 ? "reference" : `${thumbs.length} references`} already on this prompt, or pick someone who exists.` : phone ? "Give them three references and a kind and they exist everywhere. Render stays outlined until then." : "Make one — a name and one picture is enough — or pick someone who exists."}</span>
            <div className="flex items-center gap-[6px]">
              {thumbs.map((r) => <span key={r.id} className="relative h-[52px] w-[52px] flex-none overflow-hidden rounded-ctl border border-[rgba(245,246,248,.1)] ui-placeholder"><img src={r.url} alt="" className="absolute inset-0 h-full w-full object-cover" /></span>)}
              {phone && <button type="button" onClick={() => picker.current?.click()} aria-label="Add a reference" className="flex h-[52px] w-[52px] flex-none items-center justify-center rounded-ctl border border-dashed border-[rgba(245,246,248,.22)] text-[16px] font-medium leading-none text-ink-body">+</button>}
              {phone ? (
                <button type="button" onClick={() => setSheetKind((k) => (k === "character" ? "prop" : "character"))} aria-label="Kind" className="tap44 ml-auto flex h-[40px] flex-none items-center gap-[6px] self-center rounded-pill border border-border-mid px-[11px] text-[12.5px] font-medium leading-none text-ink">{sheetKind === "character" ? "Character" : "Prop"} ▾</button>
              ) : (
                <span className="ml-auto flex flex-col items-end gap-[5px]"><Mono>Kind</Mono><span className="flex gap-[4px]">{(["character", "prop"] as ElementKind[]).map((k) => <button key={k} type="button" aria-pressed={sheetKind === k} onClick={() => setSheetKind(k)} className={`tap44 rounded-pill border px-[9px] py-[6px] text-[12px] font-medium leading-none ${sheetKind === k ? "border-[rgba(245,246,248,.3)] bg-[rgba(245,246,248,.12)] text-ink" : "border-[rgba(245,246,248,.12)] text-ink-body"}`}>{k === "character" ? "Character" : "Prop"}</button>)}</span></span>
              )}
            </div>
            <div className={`flex ${phone ? "gap-[8px]" : "gap-[6px]"}`}>
              <button type="button" onClick={() => setSheetFor(nm)} className={`flex h-[44px] flex-1 items-center rounded-tile bg-ink text-[13.5px] font-semibold leading-none text-ground ${phone ? "justify-between rounded-card px-[12px]" : "justify-center gap-[10px]"}`}>Create @{nm}<span className="ui-mono ui-mono-cost text-on-primary-cost">{money.price(0)}</span></button>
              <button type="button" onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setPickFor({ name: nm, x: r.left, y: r.bottom + 6 }); }} className={`flex h-[44px] flex-1 items-center justify-center border text-[13.5px] font-medium leading-none text-ink ${phone ? "rounded-card border-[rgba(245,246,248,.16)]" : "rounded-tile border-border-mid"}`}>Pick existing</button>
            </div>
            {!phone && <Mono cost className="!leading-[1.4]">Carries a still for now · train the face later in Rig{idTerms?.terms.trainCostUsd != null ? ` · ${money.price(idTerms.terms.trainCostUsd)}` : ""}</Mono>}
          </div>
        ); })()}

        {kind !== "audio" && (
          <div className={`flex items-center gap-[8px] rounded-ctl ${well.over ? "outline outline-2 outline-ink" : well.dragging ? "outline outline-1 outline-dashed outline-[rgba(245,246,248,.35)]" : ""}`} {...well.props} data-well=""
            onDragOver={(e) => { e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) { addFiles(e.dataTransfer.files); return; } const d = readDraggedAsset(e); if (d) addFromPayload({ kind: "media", id: d.gen.id, label: d.gen.title || d.gen.prompt.slice(0, 24), url: d.gen.storedUrl ?? d.gen.sourceUrl ?? null, data: { kind: d.gen.kind } }); }}>
            <input ref={picker} type="file" accept="image/*,video/*" multiple hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
            <button type="button" onClick={() => picker.current?.click()} disabled={uploading} aria-label="Add a reference"
              className={`tap44 flex flex-none flex-col items-center justify-center gap-[2px] rounded-ctl border border-dashed border-[rgba(245,246,248,.22)] ${phone ? "ui-mono h-[56px] w-[56px] !text-[12px] tracking-normal text-ink-body" : "h-[52px] w-[52px] text-[11px] leading-[1.2] text-ink-muted"}`}>
              <span className="text-[16px] leading-none">+</span>Ref
            </button>
            {kind === "video" && phone && !frame ? (
              <span className="text-[12.5px] leading-[1.35] text-ink-body">First frame optional. A reference steers the look, not the story.</span>
            ) : kind === "video" ? (
              <span className="relative flex h-[52px] w-[52px] flex-none items-end justify-center overflow-hidden rounded-ctl border border-[rgba(245,246,248,.1)] pb-[4px] ui-placeholder">
                {frame && <img src={frame.url} alt="" className="absolute inset-0 h-full w-full object-cover" />}
                <span className="ui-mono relative !text-[9px] tracking-normal text-ink-muted max-md:!text-[12px]">{frame ? "" : "Frame"}</span>
                {frame && <button type="button" onClick={() => setRefs((p) => p.filter((r) => r.id !== frame.id))} aria-label="Remove the frame" className="ui-chip-scrim absolute right-[2px] top-[2px] rounded-badge px-[4px] py-[2px] text-[10px] leading-none text-ink">×</button>}
              </span>
            ) : (
              <span className="flex min-w-0 flex-1 gap-[6px] overflow-x-auto">
                {refs.map((r) => (
                  <span key={r.id} className="relative h-[52px] w-[52px] flex-none overflow-hidden rounded-ctl border border-[rgba(245,246,248,.1)] ui-placeholder">
                    {r.kind === "image" ? <img src={r.url} alt="" className="absolute inset-0 h-full w-full object-cover" /> : <span className="ui-mono absolute inset-0 flex items-center justify-center !text-[9px] tracking-normal text-ink-muted">Clip</span>}
                    <button type="button" onClick={() => setRefs((p) => p.filter((x) => x.id !== r.id))} aria-label={`Remove ${r.filename}`} className="ui-chip-scrim absolute right-[2px] top-[2px] rounded-badge px-[4px] py-[2px] text-[10px] leading-none text-ink">×</button>
                  </span>
                ))}
              </span>
            )}
            {kind === "video" ? (
              !(phone && !frame) && <span className="ml-auto text-right text-[12px] leading-[1.3] text-ink-body">first frame · optional</span>
            ) : (
              <Segmented label="Reference use" placement="bar" className="ml-auto flex-none" value={useAs} onChange={setUseAs} options={[{ value: "loose", label: "Loose" }, { value: "first", label: "Exact" }]} />
            )}
          </div>
        )}

        {kind !== "audio" && (
          <div className="flex flex-col gap-[6px]">
            <button type="button" onClick={() => setListOpen((o) => !o)} aria-expanded={listOpen} aria-label="Engine"
              className={`tap44 flex items-center bg-card text-left ${phone ? "gap-[10px] rounded-card border border-[rgba(245,246,248,.1)] px-[13px] py-[12px]" : "gap-[8px] rounded-tile border border-[rgba(245,246,248,.35)] px-[12px] py-[10px]"}`}>
              <span className={`flex min-w-0 flex-col ${phone ? "gap-[4px]" : "gap-[3px]"}`}><span className={phone ? "text-[14px] font-semibold leading-[1.1] text-ink" : "text-[13.5px] font-medium leading-[1.2] text-ink"}>{model.label}</span><span className={`leading-[1.3] text-ink-body ${phone ? "text-[12.5px]" : "text-[12px]"}`}>{model.use}</span></span>
              <Mono cost tone="ink" className="ml-auto flex-none whitespace-nowrap">{rateLine(modelId)}{phone ? (listOpen ? " ▴" : " ▾") : ""}</Mono>
              {!phone && <span className="text-[10px] text-ink-muted max-md:text-[12px]">{listOpen ? "▲" : "▼"}</span>}
            </button>
            {listOpen && (
              <div className="flex flex-col gap-[2px] rounded-tile border border-border-mid bg-card p-[4px]" role="listbox" aria-label="Engines">
                {choices.map((m) => {
                  const on = m.id === modelId;
                  return (
                    <button key={m.id} type="button" role="option" aria-selected={on} onClick={() => pickModel(m.id)}
                      className={`tap44 flex items-center gap-[10px] rounded-ctl border px-[10px] py-[9px] text-left ${on ? "border-[rgba(245,246,248,.5)] bg-[rgba(245,246,248,.06)]" : "border-transparent"}`}>
                      <span className={`box-border h-[14px] w-[14px] flex-none rounded-full border-[1.5px] ${on ? "border-ink bg-ink" : "border-[rgba(245,246,248,.3)]"}`} />
                      <span className="flex min-w-0 flex-col gap-[3px]"><span className="text-[13px] font-medium leading-[1.2] text-ink">{m.label}</span><span className="text-[12px] leading-[1.3] text-ink-body">{m.use}</span></span>
                      <Mono cost tone="ink" className="ml-auto whitespace-nowrap">{rateLine(m.id)}</Mono>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {kind !== "audio" ? (
          <div className="flex flex-wrap gap-[6px]">
            <button type="button" className={pill} onClick={(e) => setMenu({ which: "ratio", ...at(e) })}>{ratio}{caret}</button>
            {kind === "video" && <button type="button" className={pill} onClick={(e) => setMenu({ which: "seconds", ...at(e) })}>{seconds}s{caret}</button>}
            <button type="button" className={pill} onClick={(e) => setMenu({ which: "count", ...at(e) })}>×{count}{caret}</button>
            <button type="button" className={pill} onClick={(e) => setMenu({ which: "resolution", ...at(e) })}>{resolution.toUpperCase()}{kind === "image" ? caret : null}</button>
            {kind === "video" && model.supportsAudio && (
              <button type="button" className={pill} onClick={() => setAudio((a) => !a)} aria-pressed={audio}>Audio
                {phone
                  ? <span className={`relative inline-block h-[14px] w-[26px] rounded-[7px] ${audio ? "bg-ink" : "bg-[rgba(245,246,248,.2)]"}`}><span className={`absolute top-[2px] h-[10px] w-[10px] rounded-full ${audio ? "right-[2px] bg-ground" : "left-[2px] bg-ink"}`} /></span>
                  : <span className={`relative inline-block h-[12px] w-[22px] rounded-[6px] ${audio ? "bg-ink" : "bg-[rgba(245,246,248,.2)]"}`}><span className={`absolute top-[2px] h-[8px] w-[8px] rounded-full ${audio ? "right-[2px] bg-ground" : "left-[2px] bg-ink"}`} /></span>}
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-[10px]">
            {track === "speech" && (
              <div className="flex flex-col gap-[6px]">
                <span className="flex items-center gap-[8px]">
                  <input value={voiceQuery} onChange={(e) => setVoiceQuery(e.target.value)} placeholder="Find a voice" aria-label="Find a voice"
                    className="h-[36px] min-w-0 flex-1 rounded-pill border border-border bg-card px-[12px] text-[13px] text-ink outline-0 placeholder:text-ink-muted max-md:h-[44px] max-md:text-[16px]" />
                  <select value={sModel?.id ?? ""} onChange={(e) => setSpeechModel(e.target.value)} aria-label="Model" className="h-[36px] rounded-pill border border-border bg-card px-[10px] text-[12.5px] font-medium text-ink outline-0 max-md:h-[44px] max-md:text-[16px]">
                    {(audioSetup?.speechModels ?? []).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </span>
                <div className="flex max-h-[220px] flex-col gap-[2px] overflow-y-auto rounded-tile border border-border-mid bg-card p-[4px]" role="listbox" aria-label="Voices">
                  {shownVoices.length ? shownVoices.slice(0, 60).map((v) => {
                    const on = v.id === voice?.id;
                    return (
                      <div key={v.id} role="option" aria-selected={on} className={`flex items-center gap-[10px] rounded-ctl border px-[10px] py-[9px] ${on ? "border-[rgba(245,246,248,.5)] bg-[rgba(245,246,248,.06)]" : "border-transparent"}`}>
                        <button type="button" onClick={() => setVoiceId(v.id)} className="tap44 flex min-w-0 flex-1 flex-col gap-[3px] text-left">
                          <span className="text-[13px] font-medium leading-[1.2] text-ink">{v.name}</span>
                          <span className="truncate text-[12px] leading-[1.3] text-ink-body">{Object.values(v.labels).filter(Boolean).join(" · ") || v.description}</span>
                        </button>
                        {v.previewUrl && <button type="button" onClick={() => playSample(v)} aria-label={playing === v.id ? `Stop ${v.name}` : `Play a sample of ${v.name}`} className="tap44 flex h-[28px] w-[28px] flex-none items-center justify-center rounded-full border border-[rgba(245,246,248,.2)] text-[11px] font-medium text-ink">{playing === v.id ? "■" : "▶"}</button>}
                      </div>
                    );
                  }) : <span className="px-[10px] py-[9px] text-[12.5px] text-ink-body">{audioSetup?.voicesError ?? (signedIn ? "No voices yet." : "Sign in to pick a voice.")}</span>}
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-[6px]">
              {track === "speech" && <span className={pill}>Language <span className="text-ink-body">{voice?.labels.language ?? voice?.labels.accent ?? "any"}</span></span>}
              {track === "music" && <button type="button" className={pill} onClick={(e) => setMenu({ which: "length", ...at(e) })}>{mmss(lengthS)}{caret}</button>}
              {track === "music" && <button type="button" className={pill} onClick={() => setInstrumental((i) => !i)} aria-pressed={instrumental}>Instrumental<span className={`relative inline-block h-[12px] w-[22px] rounded-[6px] ${instrumental ? "bg-ink" : "bg-[rgba(245,246,248,.2)]"}`}><span className={`absolute top-[2px] h-[8px] w-[8px] rounded-full ${instrumental ? "right-[2px] bg-ground" : "left-[2px] bg-ink"}`} /></span></button>}
              {track === "sound" && <button type="button" className={pill} onClick={(e) => setMenu({ which: "duration", ...at(e) })}>{sfxS == null ? "Auto" : `${sfxS}s`}{caret}</button>}
              <span className={pill}><span className="ui-mono ui-mono-cost">~{mmss(audioLen)}</span></span>
            </div>
          </div>
        )}

        {kind !== "audio" && phone && (
          <div className="flex flex-col gap-[8px]">
            <span className="flex justify-between"><Mono>Setup · None carried · unfiled</Mono><button type="button" onClick={(e) => setMenu({ which: "setup", ...at(e) })} className="tap44 ui-mono text-ink">+ Row</button></span>
            {rows.length > 0 && (
              <div className="flex flex-wrap gap-[6px]">
                {rows.map(({ c, value }) => <button key={c.key} type="button" onClick={() => setRow(c.key, null)} title={`${c.label} · remove`} className={pill}>{c.options.find((o) => o.value === value)?.label ?? value}</button>)}
              </div>
            )}
            <Mono>Cast</Mono>
            <div className="flex flex-wrap gap-[6px]">
              {cast.map((m) => (
                <button key={m.id} type="button" onClick={() => insertAtCaret(`@${m.name}`)} className="tap44 flex h-[40px] items-center gap-[8px] rounded-pill border border-[rgba(245,246,248,.12)] pl-[6px] pr-[12px] text-[13px] font-medium leading-none text-ink">
                  <span className="h-[26px] w-[26px] overflow-hidden rounded-full ui-placeholder">{m.uploadId && <img src={`/api/uploads/${encodeURIComponent(m.uploadId)}`} alt="" className="h-full w-full object-cover" />}</span>@{m.name}
                </button>
              ))}
              {unknown.map((nm) => (
                <button key={nm} type="button" onClick={() => setSheetFor(nm)} className="tap44 flex h-[40px] items-center gap-[8px] rounded-pill border border-dashed border-[rgba(245,246,248,.22)] pl-[6px] pr-[12px] text-[13px] font-medium leading-none text-ink-body">
                  <span className="box-border h-[26px] w-[26px] rounded-full border border-dashed border-[rgba(245,246,248,.3)]" />@{nm} · new
                </button>
              ))}
              <button type="button" onClick={addCast} className="tap44 flex h-[40px] items-center rounded-pill border border-dashed border-[rgba(245,246,248,.22)] px-[13px] text-[13px] font-medium leading-none text-ink-body">+ Add</button>
            </div>
          </div>
        )}
        {kind !== "audio" && !phone && (
          <>
            <div className="flex flex-col gap-[8px] border-t border-hairline pt-[14px]">
              <span className="flex items-baseline justify-between"><span className="text-[13px] font-semibold leading-none text-ink">Setup</span><Mono>None carried · unfiled</Mono></span>
              <div className="flex flex-wrap gap-[5px]">
                {rows.map(({ c, value }) => <button key={c.key} type="button" onClick={() => setRow(c.key, null)} title={`${c.label} · remove`} className="tap44 rounded-pill border border-[rgba(245,246,248,.12)] px-[9px] py-[6px] text-[12px] font-medium leading-none text-ink">{c.options.find((o) => o.value === value)?.label ?? value}</button>)}
                <button type="button" onClick={(e) => setMenu({ which: "setup", ...at(e) })} className="tap44 rounded-pill border border-dashed border-[rgba(245,246,248,.22)] px-[9px] py-[6px] text-[12px] font-medium leading-none text-ink-body">+ Row</button>
              </div>
            </div>
            <div className="flex flex-col gap-[8px] border-t border-hairline pt-[14px]">
              <span className="flex items-baseline justify-between"><span className="text-[13px] font-semibold leading-none text-ink">Cast</span><Mono>@name in any prompt</Mono></span>
              <div className="flex flex-wrap gap-[6px]">
                {cast.map((m) => (
                  <button key={m.id} type="button" onClick={() => insertAtCaret(`@${m.name}`)} className="tap44 flex items-center gap-[6px] rounded-pill border border-[rgba(245,246,248,.1)] bg-card py-[5px] pl-[5px] pr-[9px] text-[12px] font-medium leading-none text-ink">
                    <span className="h-[20px] w-[20px] overflow-hidden rounded-full ui-placeholder">{m.uploadId && <img src={`/api/uploads/${encodeURIComponent(m.uploadId)}`} alt="" className="h-full w-full object-cover" />}</span>@{m.name}
                  </button>
                ))}
                <button type="button" onClick={addCast} className="tap44 rounded-pill border border-dashed border-[rgba(245,246,248,.22)] px-[10px] py-[5px] text-[12px] font-medium leading-none text-ink-body">+ Add</button>
              </div>
            </div>
          </>
        )}
      </>
  );

  return (
    <div className={`flex min-h-0 flex-col ${className}`} data-composer={kind}>
      {phone ? (
        <>
          {/* M4: the docked card over the pinned Render; the sheet opens from the card. */}
          <div className="flex flex-none flex-col border-t border-border bg-ground" data-composer-dock="">
            <button type="button" onClick={() => setSheetOpen(true)} aria-expanded={sheetOpen} aria-label="Open the composer"
              className="mx-[16px] mt-[10px] flex flex-col gap-[6px] rounded-mobile border border-[rgba(245,246,248,.12)] bg-card px-[12px] py-[10px] text-left">
              <span className="flex justify-between gap-[8px]"><Mono className="truncate">{eyebrow}</Mono><span className="ui-mono tracking-normal text-ink">↑</span></span>
              <span className={`truncate text-[13.5px] leading-[1.3] ${firstLine ? "text-ink" : "text-ink-muted"}`}>
                {firstLine ? firstLine.split(NAME_RE).map((part, i) => (i % 2 === 1 ? <mark key={i} className="rounded-badge bg-[rgba(245,246,248,.1)] px-[4px] font-medium text-ink">@{part}</mark> : <span key={i}>{part}</span>)) : "Describe the shot…"}
              </span>
            </button>
            <PinnedBar className="!border-t-0 !pt-[8px]">{primary(false)}</PinnedBar>
          </div>
          <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} label="Composer" top={60} footerPad="8px 16px 26px"
            header={
              <div className="flex h-[44px] flex-none items-center gap-[8px] px-[16px]">
                <span className="text-[15px] font-semibold leading-none text-ink">Composer</span>
                <Mono>{kind === "image" ? "Images" : kind} · unfiled</Mono>
                <button type="button" onClick={() => setSheetOpen(false)} aria-label="Close" className="tap44 ml-auto flex h-[34px] w-[34px] items-center justify-center rounded-ctl border border-border-mid text-[15px] leading-none text-ink">×</button>
              </div>
            }
            footer={<span className="flex w-full flex-col gap-[6px]">{primary(true)}<Mono className="text-center">{footLine}</Mono></span>}>
            {body}
          </Sheet>
        </>
      ) : (
        <>
          <div className="flex h-[52px] flex-none items-center justify-between border-b border-hairline px-[16px]">
            <span className="text-[15px] font-semibold leading-none text-ink">Composer</span>
            <Mono>Unfiled · file later</Mono>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-[14px] overflow-y-auto p-[16px]">{body}</div>
          <div className="flex flex-none flex-col gap-[8px] border-t border-border px-[16px] pb-[16px] pt-[12px]">
            <Button variant="primary" placement="composer" cost={cost} costSuffix={unknown.length ? ` · after @${unknown[0]} exists` : suffix} busy={busy} busyLabel="Rendering…" outlined={rail.open || unknown.length > 0} muted={unknown.length > 0} disabled={signedIn && (!ready || unknown.length > 0)} onClick={render} data-render="">
              {signedIn ? "Render" : "Sign in to render"}
            </Button>
            <Mono cost className="text-center !leading-[1.4]">Lands on the wall unfiled · file to a shot any time</Mono>
          </div>
        </>
      )}
      {menu && <Menu x={menu.x} y={menu.y} title={menu.which === "setup" ? "Setup · add a row" : menu.which === "ratio" ? "Aspect" : menu.which === "seconds" ? "Length" : menu.which === "count" ? "How many" : menu.which === "resolution" ? "Resolution" : menu.which === "length" ? "Length" : "Duration"} items={menuItems()} onClose={() => { setMenu(null); setOpenCat(null); }} />}
      {pickFor && <Menu x={pickFor.x} y={pickFor.y} title={`Instead of @${pickFor.name}`} items={cast.length ? cast.map((m): MenuItem => ({ kind: "item", label: `@${m.name}`, keys: m.kind.toUpperCase(), onSelect: () => replaceName(pickFor.name, m.name) })) : [{ kind: "note", text: "Nobody in the cast yet." }]} onClose={() => setPickFor(null)} />}
      <NewAssetSheet open={sheetFor != null} from="prompt" onClose={() => setSheetFor(null)}
        initial={{ name: sheetFor ?? "", kind: sheetKind, references: refs.filter((r) => r.kind === "image").map((r) => ({ uploadId: r.id, url: r.url, label: r.filename, kind: "image" as const })) }}
        onCreated={(c) => { if (sheetFor && c.name !== sheetFor) replaceName(sheetFor, c.name.replace(/\s+/g, "")); refreshCast(); refreshEls(); }} />
    </div>
  );
}

/**
 * The prompt with `@Name` on a .1 fill (board 8a): a textarea whose text is
 * transparent over a mirror that draws the same words with the names marked.
 * Same font, same padding, same width — the caret sits on the words.
 */
function PromptField({ value, onChange, fieldRef, placeholder, names, unknown = [], phone = false }: { value: string; onChange: (v: string) => void; fieldRef: React.RefObject<HTMLTextAreaElement | null>; placeholder: string; names: boolean; unknown?: string[]; phone?: boolean }) {
  const parts: { text: string; name: boolean; unknown?: boolean }[] = [];
  const notYet = new Set(unknown.map((n) => n.toLowerCase()));
  if (names) {
    let last = 0;
    for (const m of value.matchAll(NAME_RE)) {
      if (m.index! > last) parts.push({ text: value.slice(last, m.index), name: false });
      parts.push({ text: m[0], name: true, unknown: notYet.has(m[1].toLowerCase()) });
      last = m.index! + m[0].length;
    }
    if (last < value.length) parts.push({ text: value.slice(last), name: false });
  } else parts.push({ text: value, name: false });
  const font = "text-[14.5px] leading-[1.5] font-normal";
  return (
    <div className={`relative rounded-card border border-border-mid bg-card ${phone ? "min-h-[96px]" : "min-h-[104px]"}`}>
      <div aria-hidden="true" className={`whitespace-pre-wrap break-words px-[13px] py-[12px] ${font} max-md:text-[16px] text-ink`}>
        {parts.map((p, i) => p.name ? (p.unknown ? <span key={i} className="border-b-[1.5px] border-dashed border-ink font-medium text-ink">{p.text}</span> : <mark key={i} className="rounded-badge bg-[rgba(245,246,248,.1)] px-[4px] font-medium text-ink">{p.text}</mark>) : <span key={i}>{p.text}</span>)}
        {value.endsWith("\n") || !value ? "​" : null}
      </div>
      <textarea ref={fieldRef} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label="Prompt" spellCheck={false}
        className={`absolute inset-0 h-full w-full resize-none bg-transparent px-[13px] py-[12px] ${font} max-md:text-[16px] text-transparent caret-ink outline-0 placeholder:text-ink-muted`} />
    </div>
  );
}
