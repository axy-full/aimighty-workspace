"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useImperativeHandle,
  type Ref,
  type ChangeEvent,
  type MouseEvent as RMouseEvent,
} from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { useSession, useSignInHref } from "@/lib/session";
import { useMoney } from "@/lib/price";
import { MODELS, DEFAULT_MODEL_ID, getModel } from "@/lib/models";
import { estimateImage } from "@/lib/rateTable";
import { estimateComposerVideo } from "@/lib/composerQuote";
import { COUNTS, newBatchId } from "@/lib/variations";
import {
  CATEGORIES,
  composePrompt,
  detectSpec,
  type ShotSpec,
} from "@/lib/studio";
import { saveDraft, clearDraft } from "@/lib/draft";
import { useUploadFile } from "@/lib/useUploadFile";
import type { RefItem } from "@/lib/refs";
import { useGenAssetInput, inputAsReference, referenceIdentity, type GenAssetInputHandle } from "@/lib/genAssetInput";
import type { CastMember } from "@/lib/cast";
import { appPrompt } from "@/components/dialog";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  ArrowUpRight,
  AudioLines,
  Check,
  ChevronDown,
  Film,
  Image as ImageIcon,
  Plus,
  SlidersHorizontal,
  X,
} from "lucide-react";
import styles from "./gen.module.css";
import Menu, { type MenuItem } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import NewAssetSheet from "@/components/assets/NewAssetSheet";
import type { ElementKind } from "@/lib/rig";
import {
  useGenerationBatch,
  type GenerationBatch,
} from "@/lib/useGenerationBatch";
import { lockedClaim } from "@/lib/usePaidAction";
import {
  pendingGenerationKey,
  readPendingGeneration,
  claimPendingGeneration,
  clearPendingGeneration,
} from "@/lib/workbench/pending-generation";
import {
  useComposerPersistence,
  notifyComposerStorage,
  type PendingAudio,
} from "@/lib/useComposerPersistence";

/** The Gen creation desk. Paid requests retain the existing scoped recovery protocol. */
const subscribeHydration = () => () => {};
const clientHydrated = () => true;
const serverHydrated = () => false;
export type ComposerKind = "video" | "image" | "audio";

type Voice = {
  id: string;
  name: string;
  category: string;
  labels: Record<string, string>;
  previewUrl: string | null;
  description: string;
};
type SpeechModel = {
  id: string;
  label: string;
  creditsPerChar: number;
  note: string;
  alpha?: boolean;
};
type AudioSetup = {
  configured: boolean;
  speechModels: SpeechModel[];
  defaultSpeechModel: string;
  voices: Voice[];
  voicesError: string | null;
  account: { usdPerCredit: number } | null;
  terms: { sfxCredits: number; musicCreditsPerMinute: number };
};
type Track = "sound" | "music" | "speech";
const TRACKS: { id: Track; label: string; placeholder: string }[] = [
  {
    id: "sound",
    label: "Ambient",
    placeholder:
      "Rain on a corrugated roof, steady, close. A single fluorescent tube humming. Far off, a road. No music.",
  },
  {
    id: "music",
    label: "Music",
    placeholder:
      "Slow cinematic strings building to a brass swell, 90 bpm, hopeful, no vocals.",
  },
  {
    id: "speech",
    label: "Dialogue",
    placeholder:
      "The line, as it should be read. Direct it inline: [whispers] we shouldn't be here.",
  },
];

const mmss = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

/** `@Name` tokens in a prompt, the way the composer highlights and the engine reads them. */
const NAME_RE = /@([A-Za-z][\w'-]*(?: (?=[A-Z])[A-Z][\w'-]*)*)/g;

export type ComposerHandle = GenAssetInputHandle & { usePrompt: (text: string) => boolean };
type ComposerProps = {
  kind: ComposerKind;
  onMade?: () => void;
  initialRef?: string | null;
  className?: string;
  controller?: Ref<ComposerHandle>;
  onEditRequested?: () => void;
  onAstraRequested?: () => void;
  onUpscaleRequested?: () => void;
};
export default function Composer(props: ComposerProps) {
  const { workspace, email, signedIn } = useSession();
  const scope = JSON.stringify([
    signedIn ? workspace?.id : null,
    signedIn ? email : null,
    props.kind,
  ]);
  return <ScopedComposer key={scope} {...props} scope={scope} />;
}
function ScopedComposer({
  kind,
  onMade,
  initialRef = null,
  className = "",
  scope,
  controller,
  onEditRequested,
  onAstraRequested,
  onUpscaleRequested,
}: ComposerProps & { scope: string }) {
  const router = useRouter();
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    clientHydrated,
    serverHydrated,
  );
  const { signedIn, rates, workspace, email, requestScope } = useSession();
  const uploadFile = useUploadFile();
  const signIn = useSignInHref();
  const money = useMoney();
  const toast = useToast();
  const surface = `make:${scope}`;
  const recoveryKey = pendingGenerationKey(scope, "unfiled", surface);
  const persisted = useComposerPersistence(
    surface,
    recoveryKey,
    signedIn,
    kind === "audio",
  );
  const pendingAudio = persisted.pending ?? null;
  const generationBatch = useGenerationBatch(surface, kind !== "audio");
  const pendingBatch = generationBatch.pending;
  const batchDisplay = pendingBatch?.display;

  /* ── the words ─────────────────────────────────────────────────────── */
  const [promptState, setPromptState] = useState<string | null>(null);
  const recoveredBody = pendingAudio ? JSON.parse(pendingAudio.body) : null;
  const recoveredText = recoveredBody?.text;
  const prompt =
    batchDisplay?.prompt ??
    promptState ??
    (typeof recoveredText === "string"
      ? recoveredText
      : (persisted.draft ?? ""));
  const setPrompt = useCallback(
    (v: string) => {
      setPromptState(v);
      saveDraft(surface, v);
    },
    [surface],
  );
  const field = useRef<HTMLTextAreaElement>(null);
  const insertAtCaret = (token: string) => {
    const el = field.current;
    const at = el?.selectionStart ?? prompt.length;
    const before = prompt.slice(0, at),
      after = prompt.slice(at);
    const sp = before && !/\s$/.test(before) ? " " : "";
    const next = `${before}${sp}${token} ${after}`;
    setPrompt(next);
    requestAnimationFrame(() => {
      el?.focus();
      const p = (before + sp + token + " ").length;
      el?.setSelectionRange(p, p);
    });
  };

  /* ── references ────────────────────────────────────────────────────── */
  const [refsChoice, setRefs] = useState<RefItem[]>([]);
  const attachedRefs = useRef<RefItem[]>([]);
  const removeReference = (reference: RefItem) => {
    const next = attachedRefs.current.filter((item) => item.id !== reference.id || (item.origin ?? "upload") !== (reference.origin ?? "upload"));
    attachedRefs.current = next;
    setRefs(next);
  };
  const refs = batchDisplay?.refs ?? refsChoice;
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const receiver = useGenAssetInput({
    scope: requestScope,
    locked: !hydrated || !!pendingAudio || !!pendingBatch || busy || !!persisted.error || !!generationBatch.error,
    initialSource: initialRef,
    acceptFile(file) {
      if (attachedRefs.current.length >= 8) throw Error("Remove a reference before adding another. Up to eight are supported.");
      if (kind === "audio") throw Error("Use the production sound suite to edit existing audio.");
      if (!file.type.startsWith("image/") && !(kind === "video" && file.type.startsWith("video/")))
        throw Error(kind === "image" ? "Choose an image reference." : "Choose an image or video reference.");
    },
    upload: (file) => uploadFile(file, "reference"),
    onAsset(asset) {
      if (kind === "audio") throw Error("Use the production sound suite to edit existing audio.");
      if (asset.kind !== "image" && !(kind === "video" && asset.kind === "video"))
        throw Error(kind === "image" ? "Choose an image reference." : "Choose an image or video reference.");
      const previous = attachedRefs.current;
      if (previous.some((ref) => ref.id === asset.id && (ref.origin ?? "upload") === asset.origin)) {
        toast("This asset is already attached."); return;
      }
      if (previous.length >= 8) throw Error("Remove a reference before adding another. Up to eight are supported.");
      const role = asset.kind === "video" ? "reference_video" : kind === "video" && !previous.some((ref) => ref.role === "first_frame") ? "first_frame" : "reference_image";
      const next = [...previous, inputAsReference(asset, role)];
      attachedRefs.current = next;
      setRefs(next);
      toast(`${asset.name} added as a reference.`);
    },
    onError: toast,
  });
  const uploading = receiver.busy;
  const addFiles = receiver.useFiles;
  const [useAsChoice, setUseAs] = useState<"loose" | "first">("loose");
  const useAs = batchDisplay?.useAs ?? useAsChoice;

  /* ── the engine and its settings (§1: read from the engine, never typed) ── */
  const choices = useMemo(
    () =>
      MODELS.filter(
        (m) =>
          m.kind === (kind === "image" ? "image" : "video") &&
          !m.hidden &&
          (kind !== "video" || m.durations.length > 0),
      ),
    [kind],
  );
  const [modelChoice, setModelId] = useState<string>(() =>
    kind === "image"
      ? (MODELS.find((m) => m.kind === "image" && !m.hidden)?.id ??
        DEFAULT_MODEL_ID)
      : DEFAULT_MODEL_ID,
  );
  const modelId = batchDisplay?.modelId ?? modelChoice;
  const model = getModel(modelId);
  const [listOpen, setListOpen] = useState(false);
  const [ratioChoice, setRatio] = useState<string>(() =>
    model.ratios.includes("16:9") ? "16:9" : model.ratios[0],
  );
  const ratio = batchDisplay?.ratio ?? ratioChoice;
  const [secondsChoice, setSeconds] = useState<number>(() =>
    model.durations.includes(5) ? 5 : (model.durations[0] ?? 5),
  );
  const seconds = batchDisplay?.seconds ?? secondsChoice;
  const [resolutionChoice, setResolution] = useState<string>(() =>
    model.resolutions.includes("1080p")
      ? "1080p"
      : model.resolutions.includes("1K")
        ? "1K"
        : model.resolutions[0],
  );
  const resolution = batchDisplay?.resolution ?? resolutionChoice;
  const [countChoice, setCount] = useState(1);
  const count = batchDisplay?.count ?? countChoice;
  const [audioChoice, setAudio] = useState(true);
  const audio = batchDisplay?.audio ?? audioChoice;
  const pickModel = (id: string) => {
    const m = getModel(id);
    setModelId(id);
    setListOpen(false);
    if (!m.ratios.includes(ratio))
      setRatio(m.ratios.includes("16:9") ? "16:9" : m.ratios[0]);
    if (m.kind === "video" && !m.durations.includes(seconds))
      setSeconds(m.durations.includes(5) ? 5 : (m.durations[0] ?? 5));
    if (!m.resolutions.includes(resolution))
      setResolution(
        m.resolutions.includes("1080p")
          ? "1080p"
          : m.resolutions.includes("1K")
            ? "1K"
            : m.resolutions[0],
      );
  };
  const [menu, setMenu] = useState<{
    which:
      | "ratio"
      | "seconds"
      | "count"
      | "resolution"
      | "setup"
      | "length"
      | "duration";
    x: number;
    y: number;
  } | null>(null);
  const [openCat, setOpenCat] = useState<string | null>(null);
  const at = (e: RMouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: r.left, y: r.bottom + 6 };
  };

  /** The price of one press for this engine at these settings, in the table's unit. */
  const priceOf = useCallback(
    (
      mId: string,
      res: string,
      secs: number,
      withAudio: boolean,
      refsIn: number,
    ): number | null => {
      const m = getModel(mId);
      if (m.kind === "image") return estimateImage(rates, mId, res, refsIn);
      return estimateComposerVideo(
        rates,
        mId,
        res,
        ratio,
        secs,
        withAudio,
        refs,
      );
    },
    [rates, ratio, refs],
  );
  const unit = priceOf(
    modelId,
    resolution,
    seconds,
    audio,
    refs.filter((r) => r.kind === "image").length,
  );
  const perTakePrice =
    unit == null ? null : rates.unit === "cr" ? Math.ceil(unit - 1e-9) : unit;
  const price = perTakePrice == null ? null : perTakePrice * count;
  /** `19 CR / 5S` on a video chip; `3 CR / STILL` on an image chip. */
  const rateLine = (mId: string) => {
    const m = getModel(mId);
    const p = priceOf(
      mId,
      m.kind === "image"
        ? m.resolutions.includes(resolution)
          ? resolution
          : m.resolutions[0]
        : m.resolutions.includes(resolution)
          ? resolution
          : m.resolutions[0],
      m.kind === "image" ? 0 : m.durations.includes(seconds) ? seconds : 5,
      audio,
      0,
    );
    return p == null
      ? "—"
      : `${money.price(p)} / ${m.kind === "image" ? "still" : `${m.durations.includes(seconds) ? seconds : 5}s`}`;
  };

  /* ── setup rows and cast (§10) ─────────────────────────────────────── */
  const [specChoice, setSpec] = useState<ShotSpec>({});
  const spec = batchDisplay?.spec ?? specChoice;
  const detected = useMemo(() => detectSpec(prompt), [prompt]);
  const rows = CATEGORIES.map((c) => ({
    c,
    value: spec[c.key] ?? null,
  })).filter((r) => r.value);
  const setRow = (key: string, value: string | null) =>
    setSpec((s) => ({ ...s, [key]: value }));
  const { data: castData, refresh: refreshCast } = useApi<{
    cast: CastMember[];
  }>(signedIn && kind !== "audio" ? "/api/cast?projectId=all" : null, 0);
  const cast = useMemo(() => castData?.cast ?? [], [castData]);
  const { data: elsData, refresh: refreshEls } = useApi<{
    elements: { name: string }[];
  }>(signedIn && kind !== "audio" ? "/api/rig/elements" : null, 60_000);
  /* 3b: a name the prompt cites that nobody has made yet. */
  const known = useMemo(
    () =>
      new Set([
        ...cast.map((m) => m.name.toLowerCase()),
        ...(elsData?.elements ?? []).map((e) => e.name.toLowerCase()),
      ]),
    [cast, elsData],
  );
  const unknown = useMemo(
    () =>
      kind === "audio" || !signedIn || !!pendingBatch
        ? []
        : [
            ...new Set(
              [...prompt.matchAll(NAME_RE)]
                .map((m) => m[1])
                .filter((n) => !known.has(n.toLowerCase())),
            ),
          ],
    [prompt, known, kind, signedIn, pendingBatch],
  );
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [sheetKind, setSheetKind] = useState<ElementKind>("character");
  const [pickFor, setPickFor] = useState<{
    name: string;
    x: number;
    y: number;
  } | null>(null);
  const replaceName = (from: string, to: string) =>
    setPrompt(
      prompt.replace(
        new RegExp(
          `@${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w'-])`,
          "g",
        ),
        `@${to}`,
      ),
    );
  const addCast = async () => {
    const name = await appPrompt(
      "New cast member",
      "",
      "@Name",
      "Type the name the prompt will cite — you'll write it as @Name.",
    );
    if (!name?.trim()) return;
    const r = await fetch("/api/cast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.replace(/^@/, "").trim() }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast(j.error ?? "Not added.");
      return;
    }
    refreshCast();
    insertAtCaret(`@${j.member?.name ?? name.replace(/^@/, "").trim()}`);
  };

  /* ── audio (§10: script, kind, voice with a sample, language, duration) ── */
  const { data: audioSetup } = useApi<AudioSetup>(
    kind === "audio" && signedIn ? "/api/audio" : null,
    0,
  );
  const [trackChoice, setTrack] = useState<Track>("speech");
  const track: Track = recoveredBody?.task ?? trackChoice;
  const [voiceChoice, setVoiceId] = useState("");
  const voiceId: string = recoveredBody?.voiceId ?? voiceChoice;
  const [voiceQuery, setVoiceQuery] = useState("");
  const [speechChoice, setSpeechModel] = useState("");
  const speechModel: string = recoveredBody?.modelId ?? speechChoice;
  const [lengthChoice, setLengthS] = useState(30);
  const lengthS: number = recoveredBody?.lengthMs
    ? recoveredBody.lengthMs / 1000
    : lengthChoice;
  const [sfxChoice, setSfxS] = useState<number | null>(null);
  const sfxS: number | null = recoveredBody
    ? (recoveredBody.durationSeconds ?? null)
    : sfxChoice;
  const [instrumentalChoice, setInstrumental] = useState(true);
  const instrumental: boolean =
    recoveredBody?.instrumental ?? instrumentalChoice;
  const sample = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const voices = useMemo(() => audioSetup?.voices ?? [], [audioSetup]);
  const voice = voices.find((v) => v.id === (voiceId || voices[0]?.id)) ?? null;
  const shownVoices = useMemo(() => {
    const q = voiceQuery.trim().toLowerCase();
    return q
      ? voices.filter((v) =>
          `${v.name} ${Object.values(v.labels).join(" ")} ${v.description}`
            .toLowerCase()
            .includes(q),
        )
      : voices;
  }, [voices, voiceQuery]);
  const sModel =
    (audioSetup?.speechModels ?? []).find(
      (m) => m.id === (speechModel || audioSetup?.defaultSpeechModel),
    ) ??
    audioSetup?.speechModels[0] ??
    null;
  const spokenS = Math.max(1, Math.round(words(prompt) / 2.5));
  const audioLen =
    track === "speech"
      ? spokenS
      : track === "music"
        ? lengthS
        : (sfxS ?? Math.min(30, Math.max(3, spokenS)));
  const audioBody = useMemo(() => {
    const body: Record<string, unknown> = {
      task: track,
      text: prompt,
      projectId: null,
      shotId: null,
      title:
        track === "speech"
          ? `${voice?.name ?? "Voice"} · ${prompt.trim().slice(0, 40)}`
          : prompt.trim().slice(0, 60),
    };
    if (track === "speech")
      Object.assign(body, {
        voiceId: voice?.id,
        voiceName: voice?.name,
        modelId: sModel?.id,
      });
    if (track === "sound") Object.assign(body, { durationSeconds: sfxS });
    if (track === "music")
      Object.assign(body, { lengthMs: lengthS * 1000, instrumental });
    return JSON.stringify(body);
  }, [
    track,
    prompt,
    voice?.name,
    voice?.id,
    sModel?.id,
    sfxS,
    lengthS,
    instrumental,
  ]);
  const [quote, setQuote] = useState<{
    body: string;
    estimatedCredits: number;
    price: number;
    unit: "cr" | "usd";
    error?: string;
  } | null>(null);
  const canQuote =
    kind === "audio" &&
    signedIn &&
    !!prompt.trim() &&
    (track !== "speech" || !!voice) &&
    !pendingAudio &&
    !persisted.error;
  useEffect(() => {
    if (!canQuote) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch("/api/audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...JSON.parse(audioBody), quoteOnly: true }),
        signal: controller.signal,
      })
        .then(async (response) => {
          const result = await response.json();
          if (!response.ok)
            throw new Error(
              result.error || "Audio pricing could not be loaded.",
            );
          if (
            !Number.isInteger(result.estimatedCredits) ||
            result.estimatedCredits < 0 ||
            !Number.isFinite(result.price) ||
            result.price < 0 ||
            !["cr", "usd"].includes(result.unit)
          )
            throw new Error("Audio pricing returned an invalid estimate.");
          if (!controller.signal.aborted)
            setQuote({ ...result, body: audioBody });
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setQuote({
              body: audioBody,
              estimatedCredits: 0,
              price: 0,
              unit: "cr",
              error: error.message,
            });
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [audioBody, canQuote]);
  const currentQuote = quote?.body === audioBody && !quote.error ? quote : null;
  const audioCostLabel = (value: {
    price?: number;
    unit?: "cr" | "usd";
    credits?: number;
  }) =>
    value.unit === "usd" && typeof value.price === "number"
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: 2,
          maximumFractionDigits: 4,
        }).format(value.price)
      : `${Math.ceil(value.price ?? value.credits ?? 0).toLocaleString()} cr`;
  const costLabel =
    kind === "audio"
      ? pendingAudio
        ? audioCostLabel(pendingAudio)
        : currentQuote
          ? audioCostLabel(currentQuote)
          : canQuote && quote?.body !== audioBody
            ? "Getting quote…"
            : "Quote unavailable"
      : pendingBatch
        ? audioCostLabel({
            price:
              (pendingBatch.display.price / pendingBatch.variants.length) *
              (pendingBatch.variants.length - pendingBatch.cursor),
            unit: pendingBatch.display.unit,
          })
        : money.price(price ?? 0);
  const playSample = (v: Voice) => {
    if (!v.previewUrl) return;
    if (playing === v.id) {
      sample.current?.pause();
      setPlaying(null);
      return;
    }
    sample.current?.pause();
    const a = new Audio(v.previewUrl);
    sample.current = a;
    setPlaying(v.id);
    a.onended = () => setPlaying(null);
    a.play().catch(() => setPlaying(null));
  };

  /* ── the press ─────────────────────────────────────────────────────── */
  const ready =
    !uploading &&
    (kind === "audio"
      ? !persisted.error && (!!pendingAudio || !!currentQuote)
      : !generationBatch.error &&
        (!!pendingBatch || (prompt.trim().length > 0 && price !== null)));
  const render = async () => {
    if (!signedIn) {
      router.push(signIn);
      return;
    }
    if (!ready || busy || unknown.length) return;
    setBusy(true);
    try {
      if (kind === "audio") {
        if (!pendingAudio && !currentQuote) return;
        const proposed: PendingAudio = pendingAudio ?? {
          key: crypto.randomUUID(),
          body: JSON.stringify({
            ...JSON.parse(audioBody),
            maxCredits: currentQuote!.estimatedCredits,
          }),
          credits: currentQuote!.estimatedCredits,
          price: currentQuote!.price,
          unit: currentQuote!.unit,
        };
        const submitted = await lockedClaim(recoveryKey, () => {
          const saved = readPendingGeneration(localStorage, recoveryKey);
          if (pendingAudio && (!saved || saved.key !== pendingAudio.key))
            throw new Error(
              "This audio request has already been recovered. Refresh before starting another.",
            );
          if (saved && saved.body !== proposed.body)
            throw new Error(
              "Recover the saved audio request before starting another.",
            );
          return claimPendingGeneration(localStorage, recoveryKey, proposed);
        });
        notifyComposerStorage();
        setMenu(null);
        const r = await fetch("/api/audio", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": submitted.key,
            "X-Workspace-Id": workspace!.id,
            "X-Actor-Email": email!,
          },
          body: submitted.body,
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          if (r.headers.get("Idempotency-Status") === "complete") {
            await lockedClaim(recoveryKey, () =>
              clearPendingGeneration(localStorage, recoveryKey, submitted.key),
            );
            notifyComposerStorage();
          }
          throw new Error(
            j.error ??
              "Audio submission could not be confirmed. Recover it with the same request.",
          );
        }
        if (typeof j.id !== "string")
          throw new Error(
            "Audio submission could not be confirmed. Recover the submitted audio before starting another.",
          );
        await lockedClaim(recoveryKey, () =>
          clearPendingGeneration(localStorage, recoveryKey, submitted.key),
        );
        notifyComposerStorage();
        if (Array.isArray(j.notices) && j.notices.length)
          toast(j.notices.join(" · "));
      } else {
        const applied: ShotSpec = { ...detected, ...spec };
        const base = {
          prompt: composePrompt(prompt, applied),
          model: modelId,
          ratio,
          resolution,
          duration: seconds,
          generateAudio: audio && model.supportsAudio,
          projectId: null,
          shotId: null,
          task: "generate",
          shotSpec: applied,
          references: refs.map((r) => ({ ...referenceIdentity(r), role: r.role })),
          useAs: kind === "image" ? useAs : undefined,
          ...(rates.unit === "cr" ? { maxCredits: perTakePrice } : {}),
        };
        const batchId = count > 1 ? newBatchId() : undefined;
        const proposed: GenerationBatch = pendingBatch ?? {
          id: crypto.randomUUID(),
          cursor: 0,
          variants: Array.from({ length: count }, (_, i) => ({
            key: crypto.randomUUID(),
            body: JSON.stringify(
              batchId ? { ...base, batchId, variation: i + 1, count } : base,
            ),
          })),
          display: {
            prompt,
            modelId,
            ratio,
            resolution,
            seconds,
            count,
            audio,
            refs,
            useAs,
            spec,
            price: price!,
            unit: rates.unit,
          },
        };
        setMenu(null);
        setListOpen(false);
        setPickFor(null);
        const finished = await generationBatch.run(proposed, {
          review: async (refusal) =>
            refusal.needsReason
              ? (
                  await appPrompt(refusal.message, "", refusal.line ?? "")
                )?.trim() || null
              : undefined,
          notices: (notices) => toast(notices.join(" · ")),
        });
        if (!finished) return;
        clearDraft(surface);
        setPromptState("");
        setRefs([]);
        await generationBatch.complete(proposed.id);
      }
      clearDraft(surface);
      setPromptState("");
      setRefs([]);
      toast(`Rendering · ${costLabel} · saved to your takes`);
      onMade?.();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key === "Enter" &&
        field.current === document.activeElement
      ) {
        e.preventDefault();
        render();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  useImperativeHandle(controller, () => ({
    useAsset: receiver.useAsset,
    useFiles: receiver.useFiles,
    usePrompt(text) {
      if (busy || pendingAudio || pendingBatch) {
        toast("Recover the submitted request before replacing its prompt.");
        return false;
      }
      setPrompt(text);
      requestAnimationFrame(() => field.current?.focus());
      return true;
    },
  }));
  useEffect(
    () => () => {
      sample.current?.pause();
    },
    [],
  );

  const menuItems = (): MenuItem[] => {
    if (!menu) return [];
    if (menu.which === "ratio")
      return model.ratios.map((r) => ({
        kind: "item",
        label: r,
        onSelect: () => setRatio(r),
      }));
    if (menu.which === "seconds")
      return model.durations.map((s) => ({
        kind: "item",
        label: `${s}s`,
        onSelect: () => setSeconds(s),
      }));
    if (menu.which === "count")
      return COUNTS[model.kind].map((n) => ({
        kind: "item",
        label: `×${n}`,
        onSelect: () => setCount(n),
      }));
    if (menu.which === "resolution")
      return model.resolutions.map((r) => ({
        kind: "item",
        label: r.toUpperCase(),
        onSelect: () => setResolution(r),
      }));
    return CATEGORIES.map((c): MenuItem => ({
      kind: "sub",
      label: c.label,
      open: openCat === c.key,
      onToggle: () => setOpenCat((k) => (k === c.key ? null : c.key)),
      items: c.options.map((o) => ({
        label: o.label,
        onSelect: () => {
          setRow(c.key, o.value);
          setMenu(null);
        },
      })),
    }));
  };
  const locked = !!pendingAudio || !!pendingBatch || busy || uploading;
  const modeLabel =
    kind === "image" ? "Images" : kind === "audio" ? "Audio" : "Video";
  const audioError =
    persisted.error || (quote?.body === audioBody ? quote.error : null);
  const recovery =
    kind === "audio"
      ? pendingAudio
        ? "Your audio request is saved. Recover it to confirm the same submission."
        : null
      : pendingBatch
        ? `${pendingBatch.cursor} of ${pendingBatch.variants.length} takes submitted. ${pendingBatch.refusal ? pendingBatch.refusal.message + " Retry only the remaining takes." : "Recover to confirm the pending take and finish the remaining requests."}`
        : null;
  const error = kind === "audio" ? audioError : generationBatch.error;
  const primaryLabel = busy
    ? "Generating…"
    : !signedIn
      ? "Sign in to generate"
      : pendingAudio
        ? "Recover submitted audio"
        : pendingBatch
          ? pendingBatch.refusal
            ? "Retry remaining takes"
            : "Recover batch"
          : "Generate";
  const setting = (
    label: string,
    which: "ratio" | "seconds" | "count" | "resolution",
    value: string,
  ) => (
    <button
      type="button"
      className={styles.setting}
      onClick={(e) => setMenu({ which, ...at(e) })}
      aria-label={`${label}: ${value}`}
    >
      <span>{label}</span>
      <strong>
        {value}
        <ChevronDown size={14} />
      </strong>
    </button>
  );
  return (
    <section
      className={`${styles.composer} ${className}`}
      data-composer={kind}
      aria-label={`${modeLabel} composer`}
    >
      <div className={styles.composerScroll}>
        {(error || recovery) && (
          <p className={styles.notice} role={error ? "alert" : "status"}>
            {error || recovery}
          </p>
        )}
        <fieldset disabled={locked} className={styles.fields}>
          <div className={styles.promptStage}>
            <div className={styles.sectionLabel}>
              <span>01 / Direction</span>
              <span>
                {kind === "audio" ? "ElevenLabs" : "Text + references"}
              </span>
            </div>
            <h2>
              {kind === "audio"
                ? "Give it a voice."
                : kind === "image"
                  ? "Make the frame."
                  : "Set it in motion."}
            </h2>
            {kind === "audio" && (
              <div
                className={styles.trackTabs}
                role="group"
                aria-label="Track kind"
              >
                {TRACKS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={track === t.id}
                    onClick={() => setTrack(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={field}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              aria-label="Prompt"
              spellCheck={false}
              className={styles.prompt}
              placeholder={
                kind === "audio"
                  ? TRACKS.find((t) => t.id === track)!.placeholder
                  : kind === "image"
                    ? "Describe the subject, composition and light…"
                    : "Describe the scene, movement and atmosphere…"
              }
            />
            <div className={styles.promptMeta}>
              <span>
                {kind === "audio"
                  ? `${words(prompt)} words · approximately ${mmss(audioLen)}`
                  : "Use @name to bring in your cast"}
              </span>
              <kbd>⌘ ↵</kbd>
            </div>
          </div>
          {unknown.length > 0 && (
            <div
              className={styles.notice}
              role="group"
              aria-label={`Not an asset yet: @${unknown[0]}`}
            >
              <strong>@{unknown[0]} needs a reference</strong>
              <p>Create the asset or choose someone from your cast.</p>
              <div className={styles.inlineActions}>
                <button type="button" onClick={() => setSheetFor(unknown[0])}>
                  Create @{unknown[0]}
                </button>
                <button
                  type="button"
                  onClick={(e) => setPickFor({ name: unknown[0], ...at(e) })}
                >
                  Pick existing
                </button>
                <select
                  aria-label="Asset kind"
                  value={sheetKind}
                  onChange={(e) => setSheetKind(e.target.value as ElementKind)}
                >
                  <option value="character">Character</option>
                  <option value="prop">Prop</option>
                </select>
              </div>
            </div>
          )}
          {kind !== "audio" && (
            <div
              className={styles.references}
              aria-label="Generation references"
              onDragOver={receiver.onDragOver}
              onDrop={receiver.onDrop}
            >
              <div className={styles.sectionLabel}>
                <span>References</span>
                <span>
                  {refs.length ? `${refs.length} attached` : "Optional"}
                </span>
              </div>
              <input
                ref={picker}
                type="file"
                disabled={!hydrated || uploading}
                accept="image/*,video/*"
                multiple
                hidden
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <div className={styles.referenceRow}>
                {refs.map((r) => (
                  <div key={`${r.origin ?? "upload"}:${r.id}`} className={styles.reference} data-reference-id={`${r.origin ?? "upload"}:${r.id}`}>
                    {r.kind === "image" ? (
                      <img src={r.url} alt={r.filename} />
                    ) : (
                      <Film size={24} aria-label={r.filename} />
                    )}
                    <button
                      type="button"
                      onClick={() => removeReference(r)}
                      aria-label={`Remove ${r.filename}`}
                    >
                      <X size={14} />
                    </button>
                    <span>
                      {r.role === "first_frame"
                        ? "First frame"
                        : r.role === "last_frame"
                          ? "Last frame"
                          : "Reference"}
                    </span>
                  </div>
                ))}
                <button
                  type="button"
                  className={styles.addReference}
                  onClick={() => picker.current?.click()}
                  disabled={!hydrated || uploading}
                  aria-label="Add a reference"
                >
                  <Plus size={20} />
                  <span>{uploading ? "Uploading…" : "Add reference"}</span>
                </button>
              </div>
              <div className={styles.referenceHint}>
                {kind === "video" ? (
                  "Drop an image for the first frame, or a clip for motion."
                ) : (
                  <div
                    className={styles.trackTabs}
                    role="group"
                    aria-label="Reference use"
                  >
                    {(
                      [
                        { id: "loose", label: "Loose" },
                        { id: "first", label: "Exact" },
                      ] as const
                    ).map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        aria-pressed={useAs === item.id}
                        onClick={() => setUseAs(item.id)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          <div className={styles.settingsSection}>
            <div className={styles.sectionLabel}>
              <span>
                02 / {kind === "audio" ? "Sound settings" : "Output settings"}
              </span>
              <SlidersHorizontal size={15} />
            </div>
            {kind !== "audio" ? (
              <>
                <button
                  type="button"
                  className={styles.engine}
                  onClick={() => setListOpen(true)}
                  aria-label="Engine"
                  aria-haspopup="dialog"
                  aria-expanded={listOpen}
                >
                  <span className={styles.engineIcon}>
                    {kind === "image" ? (
                      <ImageIcon size={20} />
                    ) : (
                      <Film size={20} />
                    )}
                  </span>
                  <span>
                    <strong>{model.label}</strong>
                    <small>{model.use}</small>
                  </span>
                  <ChevronDown size={16} />
                </button>
                <div className={styles.settingsGrid}>
                  {setting("Aspect", "ratio", ratio)}
                  {kind === "video" &&
                    setting("Length", "seconds", `${seconds}s`)}
                  {setting(
                    "Resolution",
                    "resolution",
                    resolution.toUpperCase(),
                  )}
                  {setting("Variations", "count", `×${count}`)}
                </div>
                {kind === "video" && model.supportsAudio && (
                  <label className={styles.toggle}>
                    <span>
                      Original audio<small>Generate sound with the video</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={audio}
                      onChange={(e) => setAudio(e.target.checked)}
                    />
                  </label>
                )}
              </>
            ) : (
              <>
                {track === "speech" && (
                  <>
                    <label className={styles.selectLabel}>
                      Speech model
                      <select
                        aria-label="Model"
                        value={sModel?.id ?? ""}
                        onChange={(e) => setSpeechModel(e.target.value)}
                      >
                        {(audioSetup?.speechModels ?? []).map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={styles.selectLabel}>
                      Voice
                      <input
                        value={voiceQuery}
                        onChange={(e) => setVoiceQuery(e.target.value)}
                        placeholder="Find a voice"
                        aria-label="Find a voice"
                      />
                    </label>
                    <div
                      className={styles.voices}
                      role="group"
                      aria-label="Voices"
                    >
                      {shownVoices.length ? (
                        shownVoices.slice(0, 60).map((v) => (
                          <div
                            key={v.id}
                            className={styles.voice}
                            data-selected={v.id === voice?.id}
                          >
                            <button
                              type="button"
                              aria-pressed={v.id === voice?.id}
                              onClick={() => setVoiceId(v.id)}
                            >
                              <span className={styles.voiceIcon}>
                                <AudioLines size={19} />
                              </span>
                              <span>
                                <strong>{v.name}</strong>
                                <small>
                                  {Object.values(v.labels)
                                    .filter(Boolean)
                                    .join(" · ") || v.description}
                                </small>
                              </span>
                              {v.id === voice?.id && <Check size={15} />}
                            </button>
                            {v.previewUrl && (
                              <button
                                type="button"
                                onClick={() => playSample(v)}
                                aria-label={
                                  playing === v.id
                                    ? `Stop ${v.name}`
                                    : `Play a sample of ${v.name}`
                                }
                              >
                                {playing === v.id ? "■" : "▶"}
                              </button>
                            )}
                          </div>
                        ))
                      ) : (
                        <p>
                          {audioSetup?.voicesError ??
                            (signedIn
                              ? "No voices available."
                              : "Sign in to choose a voice.")}
                        </p>
                      )}
                    </div>
                  </>
                )}
                {track === "music" && (
                  <>
                    <label className={styles.selectLabel}>
                      Length
                      <select
                        aria-label="Music length"
                        value={lengthS}
                        onChange={(e) => setLengthS(Number(e.target.value))}
                      >
                        {[15, 30, 60, 120].map((n) => (
                          <option key={n} value={n}>
                            {mmss(n)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={styles.toggle}>
                      <span>
                        Instrumental<small>Music without vocals</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={instrumental}
                        onChange={(e) => setInstrumental(e.target.checked)}
                      />
                    </label>
                  </>
                )}
                {track === "sound" && (
                  <label className={styles.selectLabel}>
                    Duration
                    <select
                      aria-label="Sound duration"
                      value={sfxS ?? "auto"}
                      onChange={(e) =>
                        setSfxS(
                          e.target.value === "auto"
                            ? null
                            : Number(e.target.value),
                        )
                      }
                    >
                      <option value="auto">Auto</option>
                      {[3, 5, 10, 20].map((n) => (
                        <option key={n} value={n}>
                          {n}s
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            )}
          </div>
          {kind !== "audio" && (
            <details className={styles.details}>
              <summary>
                Camera & cast
                <span>
                  {rows.length
                    ? `${rows.length} setup rows`
                    : "Optional direction"}
                  <ChevronDown size={14} />
                </span>
              </summary>
              <div className={styles.detailBody}>
                <div className={styles.sectionLabel}>
                  <span>Camera setup</span>
                </div>
                <div className={styles.inlineActions}>
                  {rows.map(({ c, value }) => (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => setRow(c.key, null)}
                      aria-label={`Remove ${c.label}`}
                    >
                      {c.options.find((o) => o.value === value)?.label ?? value}
                      <X size={12} />
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={(e) => setMenu({ which: "setup", ...at(e) })}
                  >
                    <Plus size={14} />
                    Add setup
                  </button>
                </div>
                <div className={styles.sectionLabel}>
                  <span>Cast</span>
                  <span>@name in your prompt</span>
                </div>
                <div className={styles.inlineActions}>
                  {cast.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => insertAtCaret(`@${m.name}`)}
                    >
                      {m.uploadId && (
                        <img
                          src={`/api/uploads/${encodeURIComponent(m.uploadId)}`}
                          alt=""
                        />
                      )}
                      @{m.name}
                    </button>
                  ))}
                  <button type="button" onClick={addCast}>
                    <Plus size={14} />
                    Add cast
                  </button>
                </div>
              </div>
            </details>
          )}
        </fieldset>
      </div>
      <footer className={styles.composerFooter}>
        <div className={styles.runMeta}>
          <span>
            {kind === "audio"
              ? `${TRACKS.find((t) => t.id === track)!.label} · ~${mmss(audioLen)}`
              : `${count} ${count === 1 ? "take" : "takes"} · ${ratio} · ${kind === "video" ? `${seconds}s` : resolution}`}
          </span>
          <span>Saved to your takes</span>
        </div>
        <button
          type="button"
          className={styles.generate}
          onClick={render}
          disabled={busy || (signedIn && (!ready || unknown.length > 0))}
          data-render=""
        >
          <span>
            {primaryLabel}
            <ArrowUpRight size={18} />
          </span>
          <strong>{costLabel}</strong>
        </button>
      </footer>
      <DialogPrimitive.Root open={listOpen} onOpenChange={setListOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className={styles.dialogOverlay} />
          <DialogPrimitive.Content
            className={styles.dialog}
            aria-describedby={undefined}
          >
            <div className={styles.dialogHeader}>
              <DialogPrimitive.Title>Choose a model</DialogPrimitive.Title>
              <DialogPrimitive.Close aria-label="Close models">
                <X size={19} />
              </DialogPrimitive.Close>
            </div>
            <div className={styles.modelList}>
              {kind === "video" && onEditRequested && (
                <button
                  type="button"
                  onClick={() => {
                    setListOpen(false);
                    onEditRequested();
                  }}
                >
                  <span>
                    <strong>Seedance 2.5 Edit</strong>
                    <small>Change an existing clip, including its audio.</small>
                  </span>
                  <span>Source clip</span>
                </button>
              )}
              {kind === "image" && onUpscaleRequested && (
                <button type="button" onClick={() => { setListOpen(false); onUpscaleRequested(); }}><span><strong>Topaz Image Upscale</strong><small>Enhance an original image with precision models.</small></span><span>Source image</span></button>
              )}
              {kind === "video" && onAstraRequested && (
                <button type="button" onClick={() => { setListOpen(false); onAstraRequested(); }}>
                  <span><strong>Topaz Astra 2</strong><small>Creative upscale with frame rate and detail controls.</small></span><span>Source clip</span>
                </button>
              )}
              {choices.map((m) => (
                <button
                  type="button"
                  key={m.id}
                  aria-pressed={m.id === modelId}
                  onClick={() => pickModel(m.id)}
                >
                  <span>
                    <strong>{m.label}</strong>
                    <small>{m.use}</small>
                  </span>
                  <span>
                    {rateLine(m.id)}
                    {m.id === modelId && <Check size={16} />}
                  </span>
                </button>
              ))}
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          title={
            menu.which === "setup"
              ? "Camera setup"
              : menu.which === "ratio"
                ? "Aspect"
                : menu.which === "seconds"
                  ? "Length"
                  : menu.which === "count"
                    ? "How many"
                    : "Resolution"
          }
          items={menuItems()}
          onClose={() => {
            setMenu(null);
            setOpenCat(null);
          }}
        />
      )}
      {pickFor && (
        <Menu
          x={pickFor.x}
          y={pickFor.y}
          title={`Instead of @${pickFor.name}`}
          items={
            cast.length
              ? cast.map((m): MenuItem => ({
                  kind: "item",
                  label: `@${m.name}`,
                  onSelect: () => replaceName(pickFor.name, m.name),
                }))
              : [{ kind: "note", text: "Nobody in the cast yet." }]
          }
          onClose={() => setPickFor(null)}
        />
      )}
      <NewAssetSheet
        open={sheetFor != null}
        from="prompt"
        onClose={() => setSheetFor(null)}
        initial={{
          name: sheetFor ?? "",
          kind: sheetKind,
          references: refs
            .filter((r) => r.kind === "image")
            .map((r) => ({
              ...referenceIdentity(r),
              url: r.url,
              label: r.filename,
              kind: "image" as const,
            })),
        }}
        onCreated={(c) => {
          if (sheetFor && c.name !== sheetFor)
            replaceName(sheetFor, c.name.replace(/\s+/g, ""));
          refreshCast();
          refreshEls();
        }}
      />
    </section>
  );
}
