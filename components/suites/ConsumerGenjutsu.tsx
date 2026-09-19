"use client";
/* eslint-disable @next/next/no-img-element -- Private originals require same-origin authenticated requests. */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  ImagePlus,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import { useDraft } from "@/lib/useDraft";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { useUploadFile } from "@/lib/useUploadFile";
import {
  useGenAssetInput,
  resolveGenInput,
  type GenInputAsset,
} from "@/lib/genAssetInput";
import { libraryInput, type LibraryAsset } from "@/lib/genLibrary";
import { workbenchScopeFor } from "@/lib/workbench/request-scope";
import { fileProjectUpload } from "@/lib/workbench/project-library-client";
import { draftRequest, writeDraft } from "@/lib/workbench/draft-request";
import { applySuiteAgentPlan } from "@/lib/workbench/suite-agent-plan";
import type { Asset, Plan, Project } from "@/lib/workbench/studio";
import {
  CONSUMER_GENJUTSU_RESOLUTIONS,
  consumerGenjutsuInputSchema,
  consumerMediaKey,
  type ConsumerGenjutsuInput,
} from "@/lib/higgsfield-consumer/genjutsu-contract";
import { GENJUTSU_LABELS, type GenjutsuVariant } from "@/lib/genjutsuTypes";
import { suiteHref } from "@/lib/suites";
import GenAssetLibrary from "@/components/make/GenAssetLibrary";
import { FrameExtractControls } from "./FrameExtractControls";
import { ReferenceImagePreview } from "./ReferenceImagePreview";
import { SyncedVideoComparison } from "./SyncedVideoComparison";
import { SuiteAgentPanel } from "./SuiteAgentPanel";
import styles from "./subatomik.module.css";
import { SUBATOMIK_DIRECTIONS } from "./subatomik-directions";

const endpoint = "/api/higgsfield/consumer/genjutsu";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mediaId = /^[A-Za-z0-9_-]{1,160}$/;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
type Creative = {
  source: GenInputAsset | null;
  references: GenInputAsset[];
  prompt: string;
  resolution: ConsumerGenjutsuInput["resolution"];
};
const empty: Creative = {
  source: null,
  references: [],
  prompt: "",
  resolution: "720p",
};
type QuoteAttempt = { key: string; input: ConsumerGenjutsuInput };
type Job = {
  id: string;
  draftId: string;
  input: ConsumerGenjutsuInput;
  status:
    | "quoted"
    | "dispatching"
    | "accepted"
    | "uncertain"
    | "failed"
    | "completed";
  workspaceId: string;
  workspaceName: string;
  quoteCredits: number;
  creditUnit: "higgsfield_credits";
  quoteExpiresAt: number;
  quoteExpired?: boolean;
  providerJobId: string | null;
  result?: unknown;
  providerReceipt?: unknown;
  originalAvailable?: boolean;
  originalAvailability?: string;
  createdAt: number;
};
class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}
const preflightCodes = new Set([
  "quote_expired",
  "quote_changed",
  "workspace_changed",
  "unapproved_adjustment",
  "insufficient_credits",
  "approval_changed",
  "invalid_input",
  "preflight_unavailable",
  "reconnect_required",
  "connection_changed",
  "connection_busy",
]);
const active = (job: Job) =>
  ["dispatching", "accepted", "uncertain"].includes(job.status);
const retain = (jobs: Job[], attempted: string[]) => {
  const pin = (job: Job) =>
    active(job) || (job.status === "quoted" && attempted.includes(job.id));
  return [...jobs.filter(pin), ...jobs.filter((job) => !pin(job))].slice(0, 25);
};
function parseJob(value: unknown, draftId: string): Job {
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    value.draftId !== draftId ||
    ![
      "quoted",
      "dispatching",
      "accepted",
      "uncertain",
      "failed",
      "completed",
    ].includes(String(value.status)) ||
    typeof value.workspaceId !== "string" ||
    !uuid.test(value.workspaceId) ||
    typeof value.workspaceName !== "string" ||
    value.workspaceName.length > 200 ||
    value.creditUnit !== "higgsfield_credits" ||
    typeof value.quoteCredits !== "number" ||
    !Number.isFinite(value.quoteCredits) ||
    value.quoteCredits <= 0 ||
    value.quoteCredits > 100000 ||
    typeof value.quoteExpiresAt !== "number" ||
    !Number.isFinite(value.quoteExpiresAt) ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    !(
      value.providerJobId === null ||
      (typeof value.providerJobId === "string" &&
        uuid.test(value.providerJobId))
    )
  )
    throw Error(
      "The saved Genjutsu job could not be verified. Refresh saved jobs before continuing.",
    );
  return {
    ...value,
    input: consumerGenjutsuInputSchema.parse(value.input),
  } as Job;
}
function original(job: Job): Asset | null {
  if (
    job.status !== "completed" ||
    job.originalAvailable !== true ||
    job.originalAvailability !== "available" ||
    !object(job.result) ||
    !object(job.result.original)
  )
    return null;
  const result = job.result.original,
    asset = result.asset;
  if (
    !object(asset) ||
    typeof result.generationId !== "string" ||
    !/^gen_hfc_[a-f0-9]{40}$/.test(result.generationId) ||
    !job.providerJobId ||
    result.providerJobId !== job.providerJobId ||
    result.creditUnit !== "higgsfield_credits" ||
    result.credits !== job.quoteCredits ||
    typeof result.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(result.sha256) ||
    ![result.bytes, result.width, result.height, result.seconds].every(
      (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
    ) ||
    asset.generationId !== result.generationId ||
    asset.kind !== "video" ||
    asset.mime !== "video/mp4" ||
    asset.url !== `/api/media/${result.generationId}`
  )
    return null;
  return {
    id: result.generationId,
    generationId: result.generationId,
    url: asset.url,
    kind: "video",
    mime: "video/mp4",
    name: `${GENJUTSU_LABELS[job.input.variant]} · ${job.input.prompt.slice(0, 80) || "Genjutsu take"}`,
    category: "Genjutsu",
    description: `${GENJUTSU_LABELS[job.input.variant]} · ${job.input.resolution}`,
    prompt: job.input.prompt,
    status: "Draft",
    version: 1,
    locked: false,
    refs: [],
  };
}
function storedAsset(
  value: unknown,
  kind: "image" | "video",
): GenInputAsset | null {
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    !mediaId.test(value.id) ||
    !["upload", "generation"].includes(String(value.origin)) ||
    value.kind !== kind
  )
    return null;
  const origin = value.origin as "upload" | "generation";
  return {
    id: value.id,
    origin,
    key: `${origin}:${value.id}`,
    kind,
    url: `/api/${origin === "upload" ? "uploads" : "media"}/${encodeURIComponent(value.id)}`,
    name:
      typeof value.name === "string"
        ? value.name.slice(0, 160)
        : "Saved original",
    seconds:
      typeof value.seconds === "number" && Number.isFinite(value.seconds)
        ? value.seconds
        : null,
    mime: "",
    bytes: 0,
    width: null,
    height: null,
    sha256: "",
  };
}
function creative(value: unknown): Creative {
  if (!object(value)) return empty;
  const references = Array.isArray(value.references)
    ? value.references
        .map((v) => storedAsset(v, "image"))
        .filter((v): v is GenInputAsset => !!v)
    : [];
  return {
    source: storedAsset(value.source, "video"),
    references: [...new Map(references.map((v) => [v.key, v])).values()].slice(
      0,
      30,
    ),
    prompt: typeof value.prompt === "string" ? value.prompt.slice(0, 5000) : "",
    resolution: CONSUMER_GENJUTSU_RESOLUTIONS.includes(
      value.resolution as Creative["resolution"],
    )
      ? (value.resolution as Creative["resolution"])
      : "720p",
  };
}
const identity = (asset: GenInputAsset) =>
  asset.origin === "upload" ? { uploadId: asset.id } : { genId: asset.id };
const mediaUrl = (input: ConsumerGenjutsuInput["source"]) =>
  input.uploadId
    ? `/api/uploads/${encodeURIComponent(input.uploadId)}`
    : `/api/media/${encodeURIComponent(input.genId!)}`;

/** Consumer credits and job receipts are separate from Particl generation admission. */
export function ConsumerGenjutsu({
  project,
  scope,
  variant,
  refreshProject,
}: {
  project: Project;
  scope: string;
  variant: GenjutsuVariant;
  refreshProject: () => Promise<void>;
}) {
  const request = useScopedFetch(scope),
    upload = useUploadFile(),
    router = useRouter(),
    query = useSearchParams();
  const draft = useDraft<Creative>(
      `subatomik-consumer:${project.id}:${variant}`,
      empty,
    ),
    input = creative(draft.value);
  const attemptKey = `particl-consumer-genjutsu:${encodeURIComponent(scope)}:${encodeURIComponent(project.id)}:attempts`;
  const quoteAttemptKey = `${attemptKey}:quote`;
  const [quoteAttempt, setQuoteAttempt] = useState<QuoteAttempt | null>(null),
    [quoteStorageError, setQuoteStorageError] = useState("");
  const [attemptStorageError, setAttemptStorageError] = useState("");
  const quoteInFlight = useRef<QuoteAttempt | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]),
    [selectedId, setSelectedId] = useState(""),
    [attempts, setAttempts] = useState<string[]>([]);
  const [capability, setCapability] = useState<{
    owner: boolean;
    connected: boolean;
    suspended: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [disclosed, setDisclosed] = useState(false),
    [approved, setApproved] = useState(false),
    [frameBusy, setFrameBusy] = useState(false),
    [search, setSearch] = useState("");
  const [preview, setPreview] = useState<GenInputAsset | null>(null),
    [clock, setClock] = useState(() => Date.now()),
    [nextPoll, setNextPoll] = useState<Record<string, number>>({});
  const pending = useRef(false),
    live = useRef(false),
    lifetime = useRef(0),
    attemptIds = useRef<string[]>([]),
    incoming = useRef<GenInputAsset[]>(input.references),
    recreated = useRef("");
  const videoPicker = useRef<HTMLInputElement>(null),
    imagePicker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    incoming.current = input.references;
  }, [input.references]);
  const normalized = input.source
    ? {
        variant,
        resolution: input.resolution,
        prompt: input.prompt,
        source: identity(input.source),
        references: input.references.map(identity),
      }
    : null;
  const selected = jobs.find((job) => job.id === selectedId),
    missing = attempts.filter((id) => !jobs.some((job) => job.id === id));
  const unresolved =
    !!missing.length ||
    jobs.some(
      (job) =>
        ["dispatching", "uncertain"].includes(job.status) ||
        (job.status === "quoted" && attempts.includes(job.id)),
    );
  const matches =
    !!selected &&
    !!normalized &&
    JSON.stringify(selected.input) === JSON.stringify(normalized);
  const locked =
    !!busy ||
    frameBusy ||
    !!quoteAttempt ||
    !!quoteStorageError ||
    !!attemptStorageError;
  function store(next: Creative) {
    const compact = (asset: GenInputAsset | null) =>
      asset
        ? {
            id: asset.id,
            origin: asset.origin,
            name: asset.name.slice(0, 80),
            kind: asset.kind,
            seconds: asset.seconds,
          }
        : null;
    draft.set({
      source: compact(next.source),
      references: next.references.map(compact),
      prompt: next.prompt,
      resolution: next.resolution,
    } as Creative);
    setApproved(false);
    setDisclosed(false);
    setNotice("");
  }
  const change = (patch: Partial<Creative>) => {
    if (!locked) store({ ...input, ...patch });
  };
  const confirmAttempts = useCallback(
    (saved: Job[]) => {
      const byId = new Map(saved.map((job) => [job.id, job]));
      const next = attemptIds.current.filter((id) => {
        const job = byId.get(id);
        return (
          !job ||
          ["dispatching", "uncertain"].includes(job.status) ||
          (job.status === "quoted" && job.quoteExpired !== true)
        );
      });
      try {
        localStorage.setItem(attemptKey, JSON.stringify(next));
        attemptIds.current = next;
        setAttempts(next);
      } catch {
        /* Keep the durable guard until its resolution can be saved. */
      }
    },
    [attemptKey],
  );
  const json = useCallback(
    async (url: string, init?: RequestInit) => {
      const response = await request(url, { cache: "no-store", ...init });
      const value = await response.json().catch(() => null);
      if (!response.ok || !object(value))
        throw new RequestError(
          typeof value?.error === "string"
            ? value.error
            : "The saved Genjutsu request could not be read. Refresh before continuing.",
          response.status,
          typeof value?.code === "string" ? value.code : undefined,
        );
      return value;
    },
    [request],
  );
  const refresh = useCallback(async () => {
    if (pending.current) return;
    const token = lifetime.current;
    pending.current = true;
    setBusy("refresh");
    setError("");
    try {
      const me = await json("/api/me");
      if (!live.current || token !== lifetime.current) return;
      if (
        typeof me.id !== "string" ||
        !object(me.workspace) ||
        typeof me.workspace.id !== "string" ||
        workbenchScopeFor(me.workspace.id, me.id) !== scope
      )
        throw Error(
          "The account or workspace changed. Reload the selected project.",
        );
      if (me.owner !== true) {
        setCapability({ owner: false, connected: false, suspended: false });
        setJobs([]);
        return;
      }
      const value = await json(
        `${endpoint}?${new URLSearchParams({ draftId: project.id })}`,
      );
      if (!live.current || token !== lifetime.current) return;
      if (
        !Array.isArray(value.jobs) ||
        value.jobs.length > 25 ||
        !object(value.connection)
      )
        throw Error("Saved Genjutsu jobs could not be verified.");
      const saved = value.jobs.map((job) => parseJob(job, project.id));
      confirmAttempts(saved);
      setJobs(retain(saved, attemptIds.current));
      setCapability({
        owner: true,
        connected:
          value.connection.connected === true &&
          value.connection.requiresReconnect !== true,
        suspended: me.workspace.suspended === true,
      });
      setClock(Date.now());
    } catch (cause) {
      if (live.current && token === lifetime.current) {
        setCapability(null);
        setError(
          cause instanceof Error
            ? cause.message
            : "Saved jobs could not be loaded.",
        );
      }
    } finally {
      if (token === lifetime.current) {
        pending.current = false;
        if (live.current) setBusy("");
      }
    }
  }, [json, scope, project.id, confirmAttempts]);
  useEffect(() => {
    const mounted = ++lifetime.current;
    live.current = true;
    try {
      const saved: unknown = JSON.parse(
        localStorage.getItem(attemptKey) ?? "[]",
      );
      if (
        !Array.isArray(saved) ||
        saved.length > 100 ||
        saved.some((id) => typeof id !== "string" || !uuid.test(id))
      )
        throw Error("Invalid generation recovery record");
      attemptIds.current = saved as string[];
      setAttempts(attemptIds.current);
    } catch {
      setAttemptStorageError(
        "The saved generation recovery record could not be read. Review existing jobs with workspace support before another generation; discarding a quote does not clear this guard.",
      );
    }
    try {
      const raw = localStorage.getItem(quoteAttemptKey);
      if (raw) {
        const value: unknown = JSON.parse(raw);
        if (
          !object(value) ||
          typeof value.key !== "string" ||
          !uuid.test(value.key)
        )
          throw Error("Invalid quote recovery record");
        const saved = {
          key: value.key,
          input: consumerGenjutsuInputSchema.parse(value.input),
        };
        quoteInFlight.current = saved;
        setQuoteAttempt(saved);
      }
    } catch {
      setQuoteStorageError(
        "The saved quote recovery record could not be read. Keep this browser record and contact workspace support before copying originals again.",
      );
    }
    void refresh();
    // Invalidate asynchronous actions from this captured account/project mount.
    return () => {
      live.current = false;
      lifetime.current = mounted + 1;
      pending.current = false;
    };
  }, [attemptKey, quoteAttemptKey, refresh]);
  useEffect(() => {
    if (!jobs.length) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [jobs.length]);
  const receiver = useGenAssetInput({
    scope,
    locked,
    acceptFile(file, target) {
      if (target === "source" && !/\.(mp4|mov|webm)$/i.test(file.name))
        throw Error("Choose an MP4, MOV or WebM source video.");
      if (
        target === "reference" &&
        !["image/jpeg", "image/png", "image/webp"].includes(file.type)
      )
        throw Error("Choose a JPEG, PNG or WebP reference image.");
      if (file.size > 50 * 1024 * 1024)
        throw Error(
          "Each original copied to the connected account must be no larger than 50 MB.",
        );
    },
    upload: async (file) => {
      const saved = await upload(
        file,
        /\.(mp4|mov|webm)$/i.test(file.name) ? "chat" : "reference",
      );
      await fileProjectUpload(project.id, saved.id, scope);
      return saved;
    },
    onAsset(asset, target) {
      if (
        (target === "source" && asset.kind !== "video") ||
        (target === "reference" && asset.kind !== "image")
      )
        throw Error("Choose a video source or a still-image reference.");
      if (asset.bytes > 50 * 1024 * 1024)
        throw Error(
          "Each original copied to the connected account must be no larger than 50 MB.",
        );
      if (asset.kind === "video") {
        if (asset.seconds !== null && (asset.seconds < 4 || asset.seconds > 30))
          throw Error("Choose a source clip between 4 and 30 seconds.");
        store({ ...input, source: asset });
      } else if (asset.kind === "image") {
        if (incoming.current.some((item) => item.key === asset.key)) return;
        if (incoming.current.length >= 30)
          throw Error("Use up to 30 image references.");
        incoming.current = [...incoming.current, asset];
        store({ ...input, references: incoming.current });
      } else throw Error("Choose a video source or a still-image reference.");
      setError("");
    },
    onError: setError,
  });
  const blocked = locked || receiver.busy;
  const canQuote =
    !!capability?.owner &&
    capability.connected &&
    !capability.suspended &&
    !blocked &&
    !unresolved &&
    !!normalized &&
    disclosed;
  const canSubmit =
    !!capability?.owner &&
    capability.connected &&
    !capability.suspended &&
    !blocked &&
    !unresolved &&
    selected?.status === "quoted" &&
    matches &&
    approved &&
    selected.quoteExpiresAt > clock &&
    !attempts.includes(selected.id);
  function saveJob(job: Job) {
    setJobs((before) =>
      retain(
        [job, ...before.filter((item) => item.id !== job.id)],
        attemptIds.current,
      ),
    );
    setSelectedId(job.id);
  }
  function discardQuote() {
    if (pending.current || busy || frameBusy) return;
    try {
      localStorage.removeItem(quoteAttemptKey);
      quoteInFlight.current = null;
      setQuoteAttempt(null);
      setQuoteStorageError("");
      setSelectedId("");
      setApproved(false);
      setDisclosed(false);
      setError("");
      setNotice(
        "Unsubmitted quote request discarded. Originals already copied may remain in the connected account. A quote request does not authorize generation; saved generation attempts are unchanged.",
      );
    } catch {
      setError(
        "The quote recovery record could not be cleared in this browser. It remains locked.",
      );
    }
  }
  async function act(
    action: "quote" | "submit" | "status",
    job: Job | null | undefined = selected,
    missingId?: string,
  ) {
    const recoveringQuote = action === "quote" && !!quoteInFlight.current;
    if (
      pending.current ||
      !capability?.owner ||
      (action === "quote" &&
        !(recoveringQuote
          ? capability.connected &&
            !capability.suspended &&
            !busy &&
            !frameBusy &&
            !receiver.busy &&
            !quoteStorageError
          : canQuote)) ||
      (action === "submit" && (!canSubmit || job?.id !== selectedId))
    )
      return;
    if (
      action === "status" &&
      ((!job && !missing.includes(missingId ?? "")) ||
        (job && clock < (nextPoll[job.id] ?? 0)))
    )
      return;
    const token = lifetime.current;
    pending.current = true;
    setBusy(action);
    setError("");
    setNotice("");
    if (action === "quote") setApproved(false);
    try {
      if (action === "submit") {
        const next = [...new Set([...attemptIds.current, job!.id])].slice(-100);
        try {
          localStorage.setItem(attemptKey, JSON.stringify(next));
        } catch {
          throw Error(
            "Enable browser storage to retain the submission recovery record before generating.",
          );
        }
        attemptIds.current = next;
        setAttempts(next);
        setApproved(false);
      }
      if (action === "quote" && !quoteInFlight.current) {
        const saved = {
          key: crypto.randomUUID(),
          input: consumerGenjutsuInputSchema.parse(normalized),
        };
        try {
          localStorage.setItem(quoteAttemptKey, JSON.stringify(saved));
        } catch {
          throw Error(
            "Enable browser storage before copying originals so this quote can be recovered safely.",
          );
        }
        quoteInFlight.current = saved;
        setQuoteAttempt(saved);
      }
      const body =
        action === "quote"
          ? {
              action,
              draftId: project.id,
              input: quoteInFlight.current!.input,
              idempotencyKey: quoteInFlight.current!.key,
            }
          : {
              action,
              draftId: project.id,
              id: job?.id ?? missingId!,
              ...(action === "submit"
                ? { workspaceId: job!.workspaceId, credits: job!.quoteCredits }
                : {}),
            };
      const value = await json(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!live.current || token !== lifetime.current) return;
      const saved = parseJob(value.job, project.id);
      confirmAttempts([saved]);
      saveJob(saved);
      if (action === "quote") {
        try {
          localStorage.removeItem(quoteAttemptKey);
          quoteInFlight.current = null;
          setQuoteAttempt(null);
        } catch {
          throw Error(
            "The quote is saved, but browser recovery storage could not be cleared. Recover this exact quote again before generating.",
          );
        }
        setNotice(
          "Originals copied to the connected account for this quote. Review its wallet and exact connected-credit price.",
        );
      }
      if (action === "submit")
        setNotice(
          "The submission is recorded. Check this saved job for its result; it will not be submitted again.",
        );
      if (action === "status") {
        const delay =
          typeof value.pollAfterSeconds === "number" &&
          Number.isFinite(value.pollAfterSeconds)
            ? Math.min(3600, Math.max(15, value.pollAfterSeconds))
            : 30;
        setNextPoll((before) => ({
          ...before,
          [saved.id]: Date.now() + delay * 1000,
        }));
        setNotice(
          "Saved job checked. Its receipt and current original availability are shown below.",
        );
      }
    } catch (cause) {
      if (live.current && token === lifetime.current) {
        if (
          action === "submit" &&
          job &&
          cause instanceof RequestError &&
          ([400, 423, 429].includes(cause.status) ||
            (!!cause.code && preflightCodes.has(cause.code)))
        ) {
          const next = attemptIds.current.filter((id) => id !== job.id);
          try {
            localStorage.setItem(attemptKey, JSON.stringify(next));
            attemptIds.current = next;
            setAttempts(next);
          } catch {
            /* Preserve guard. */
          }
          setSelectedId("");
          setApproved(false);
        }
        setError(
          cause instanceof Error
            ? cause.message
            : "The request could not be completed. Recover the saved job before trying again.",
        );
      }
    } finally {
      if (token === lifetime.current) {
        pending.current = false;
        if (live.current) setBusy("");
      }
    }
  }
  async function recreate(job: Job) {
    if (blocked || pending.current || unresolved) return;
    if (job.input.variant !== variant) {
      router.replace(
        `${suiteHref("subatomik", project.id, job.input.variant)}&account=higgsfield&recreateConsumer=${encodeURIComponent(job.id)}`,
      );
      return;
    }
    const token = lifetime.current;
    pending.current = true;
    setBusy("restore");
    setError("");
    setApproved(false);
    setDisclosed(false);
    setSelectedId("");
    try {
      const assets = await Promise.all(
        [job.input.source, ...job.input.references].map((ref) =>
          resolveGenInput(consumerMediaKey(ref), scope),
        ),
      );
      if (!live.current || token !== lifetime.current) return;
      if (
        assets[0].kind !== "video" ||
        assets.slice(1).some((asset) => asset.kind !== "image")
      )
        throw Error(
          "One of the saved originals is no longer the expected media type.",
        );
      incoming.current = assets.slice(1);
      store({
        source: assets[0],
        references: assets.slice(1),
        prompt: job.input.prompt,
        resolution: job.input.resolution,
      });
      setNotice(
        "Originals and settings restored. Review a fresh connected-credit quote before generating.",
      );
      if (query.has("recreateConsumer"))
        router.replace(
          `${suiteHref("subatomik", project.id, variant)}&account=higgsfield`,
        );
    } catch (cause) {
      if (live.current && token === lifetime.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Saved originals are unavailable.",
        );
    } finally {
      if (token === lifetime.current) {
        pending.current = false;
        if (live.current) setBusy("");
      }
    }
  }
  useEffect(() => {
    const id = query.get("recreateConsumer"),
      job = jobs.find((item) => item.id === id);
    if (!id || !job || blocked || recreated.current === id) return;
    recreated.current = id;
    void recreate(job);
  });
  async function mutateProject(
    apply: (latest: Project) => Project,
    edit = false,
  ) {
    if (pending.current || blocked) return;
    const token = lifetime.current;
    pending.current = true;
    setBusy("attach");
    setError("");
    try {
      const latest = await draftRequest<{
        project: Project | null;
        revision: number;
      }>(`/api/workbench/projects?id=${encodeURIComponent(project.id)}`, scope);
      if (!live.current || token !== lifetime.current) return;
      if (
        latest.project?.id !== project.id ||
        latest.project.productionProjectId !== project.productionProjectId
      )
        throw Error("The selected project changed. Reload before saving.");
      await writeDraft("/api/workbench", scope, {
        project: apply(latest.project),
        revision: latest.revision,
      });
      if (!live.current || token !== lifetime.current) return;
      await refreshProject();
      if (live.current && token === lifetime.current) {
        if (edit) router.push(suiteHref("particl", project.id, "edit"));
        else
          setNotice(
            "Editable agent actions saved to Rig. Each render needs a separate approval.",
          );
      }
    } catch (cause) {
      if (live.current && token === lifetime.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The original could not be saved in this project.",
        );
    } finally {
      if (token === lifetime.current) {
        pending.current = false;
        if (live.current) setBusy("");
      }
    }
  }
  function openInEdit(job: Job, asset: Asset) {
    void mutateProject((latest) => {
      if (
        !latest.assets.some(
          (item) => item.generationId === asset.generationId,
        ) &&
        latest.assets.length >= 500
      )
        throw Error(
          "The project already contains 500 assets. Remove an unused filing first.",
        );
      const saved =
        latest.assets.find(
          (item) => item.generationId === asset.generationId,
        ) ?? asset;
      const receipt =
        object(job.result) && object(job.result.original)
          ? job.result.original
          : null;
      if (!receipt || typeof receipt.seconds !== "number")
        throw Error("The original duration is unavailable.");
      return {
        ...latest,
        assets: latest.assets.some((item) => item.id === saved.id)
          ? latest.assets
          : [...latest.assets, saved],
        shots: latest.shots.some((shot) => shot.assetId === saved.id)
          ? latest.shots
          : [
              ...latest.shots,
              {
                id: crypto.randomUUID(),
                name: saved.name.slice(0, 200),
                assetId: saved.id,
                duration: Math.max(1, Math.round(receipt.seconds * latest.fps)),
                sourceIn: 0,
                note: saved.description,
              },
            ],
      };
    }, true);
  }
  function libraryTool(asset: LibraryAsset, task: "edit" | "upscale") {
    const kind = asset.value.kind;
    router.push(
      `/generate?${new URLSearchParams({ project: project.id, mode: kind === "video" ? "video" : "images", ...(kind === "video" || task === "upscale" ? { task, source: `${asset.origin}:${asset.value.id}` } : { ref: `${asset.origin}:${asset.value.id}` }) })}`,
    );
  }
  const output = selected ? original(selected) : null;
  return (
    <>
      <div className={styles.columns}>
        <section
          className={`suite-panel ${styles.creator}`}
          aria-label="Connected account Genjutsu"
        >
          <div className="suite-section-heading">
            <div>
              <h2>{GENJUTSU_LABELS[variant]}</h2>
              <p>
                Uses the workspace owner’s connected account · 4–30 second
                source · up to 30 images · up to 1080p.
              </p>
            </div>
          </div>
          <details className={styles.guide}>
            <summary>How it works</summary>
            <ol>
              <li>
                <strong>Choose the transformation.</strong> Motion Transfer
                follows a source movement with a new visual treatment. Object
                Swap replaces a subject, object or product within the shot.
              </li>
              <li>
                <strong>Select originals.</strong> Use a 4–30 second source
                video and up to 30 ordered still references. Preview references,
                change their order or extract an original start/end frame.
              </li>
              <li>
                <strong>Direct the result.</strong> Choose 480p, 720p or 1080p
                and optionally describe what should change and what stays
                consistent.
              </li>
              <li>
                <strong>Review copying and cost.</strong> Approve copying the
                selected files to your connected account for an exact quote,
                then separately approve its wallet and connected-credit price.
              </li>
              <li>
                <strong>Compare and finish.</strong> Check the existing job,
                compare retained originals, download the result or use it in
                Edit. Recreate restores references and requires a fresh quote.
              </li>
            </ol>
            <p>
              <a
                href="https://higgsfield.ai/ai/video?model=genjutsu"
                target="_blank"
                rel="noopener noreferrer"
              >
                External motion library
              </a>{" "}
              opens the provider’s external preset gallery. The gallery is not
              an embedded Particl catalog.
            </p>
          </details>
          <p className={styles.hint}>
            Connected credits are separate from Particl workspace billing. A
            quote copies your selected originals to the connected account;
            generation requires another explicit approval.
          </p>
          {!!quoteStorageError && (
            <p role="alert" className={styles.error}>
              {quoteStorageError}
            </p>
          )}
          {!!attemptStorageError && (
            <p role="alert" className={styles.error}>
              {attemptStorageError}
            </p>
          )}
          {(quoteAttempt || quoteStorageError) && (
            <div
              className={styles.quote}
              aria-label="Saved Genjutsu quote request"
            >
              <strong>Original-copy request needs recovery</strong>
              {quoteAttempt && (
                <>
                  <p>
                    {GENJUTSU_LABELS[quoteAttempt.input.variant]} ·{" "}
                    {quoteAttempt.input.resolution} ·{" "}
                    {quoteAttempt.input.references.length} image references.
                    Recover the same request before changing originals or
                    starting another quote.
                  </p>
                  <button
                    type="button"
                    className="suite-primary"
                    disabled={
                      !!busy ||
                      frameBusy ||
                      !capability?.connected ||
                      !!quoteStorageError
                    }
                    onClick={() => void act("quote")}
                  >
                    Recover saved Genjutsu quote
                  </button>
                </>
              )}
              <p>
                Discarding this unsubmitted quote allows a new request.
                Originals already copied may remain in the connected account
                and a new quote may copy them again. This copy request does not authorize
                generation.
              </p>
              <button
                type="button"
                className="suite-button"
                disabled={!!busy || frameBusy}
                onClick={discardQuote}
              >
                Discard unsubmitted quote request
              </button>
            </div>
          )}
          {capability?.owner === false ? (
            <p>
              Only this workspace’s owner can use its connected account. The
              shared generation workflow bills the Particl workspace instead.
            </p>
          ) : (
            <>
              {capability && !capability.connected && (
                <p className={styles.hint}>
                  Connect or reconnect your account in{" "}
                  <a href="/settings#engines">Workspace settings</a>.
                </p>
              )}
              {capability?.suspended && (
                <p role="status">
                  Rendering is paused in this workspace. Saved receipts remain
                  available.
                </p>
              )}
              <fieldset className={styles.form} disabled={blocked}>
                <div
                  className={styles.source}
                  aria-label="Connected Genjutsu source drop area"
                  onDragOver={receiver.onDragOver}
                  onDrop={(event) => receiver.onDrop(event, "source")}
                >
                  <div className={styles.row}>
                    <strong>Source video</strong>
                    <span>4–30 seconds · maximum 50 MB</span>
                  </div>
                  {input.source ? (
                    <>
                      <video
                        aria-label="Connected Genjutsu source preview"
                        src={input.source.url}
                        controls
                        playsInline
                        preload="metadata"
                      />
                      <div className={styles.row}>
                        <span>{input.source.name}</span>
                        <button
                          type="button"
                          className="suite-text-button"
                          onClick={() => change({ source: null })}
                        >
                          Remove source
                        </button>
                      </div>
                    </>
                  ) : (
                    <p>
                      Choose or drag a video from the workspace library, or
                      upload an original.
                    </p>
                  )}
                  <button
                    type="button"
                    className="suite-button"
                    onClick={() => videoPicker.current?.click()}
                  >
                    <Upload size={14} />
                    Upload video
                  </button>
                  <input
                    hidden
                    ref={videoPicker}
                    type="file"
                    accept=".mp4,.mov,.webm,video/*"
                    aria-label="Upload connected Genjutsu source video"
                    onChange={(event) => {
                      if (event.target.files)
                        void receiver.useFiles(event.target.files, "source");
                      event.target.value = "";
                    }}
                  />
                  <FrameExtractControls
                    source={input.source}
                    projectId={project.id}
                    scope={scope}
                    disabled={blocked || input.references.length >= 30}
                    onBusyChange={setFrameBusy}
                    onCreated={(asset) => {
                      if (
                        !live.current ||
                        pending.current ||
                        incoming.current.length >= 30
                      )
                        return;
                      incoming.current = [...incoming.current, asset];
                      store({ ...input, references: incoming.current });
                    }}
                  />
                </div>
                <div
                  className={styles.source}
                  aria-label="Connected Genjutsu reference drop area"
                  onDragOver={receiver.onDragOver}
                  onDrop={(event) => receiver.onDrop(event, "reference")}
                >
                  <div className={styles.row}>
                    <strong>Image references</strong>
                    <span>{input.references.length} / 30 · optional</span>
                  </div>
                  <div className={styles.references}>
                    {input.references.map((asset, index) => (
                      <figure key={asset.key}>
                        <button
                          className={styles.referencePreview}
                          type="button"
                          aria-label={`Enlarge reference ${asset.name}`}
                          onClick={() => setPreview(asset)}
                        >
                          <img src={asset.url} alt={asset.name} />
                        </button>
                        <figcaption>
                          {index + 1} · {asset.name}
                        </figcaption>
                        <button
                          type="button"
                          className={styles.referenceRemove}
                          aria-label={`Remove reference ${asset.name}`}
                          onClick={() => {
                            incoming.current = input.references.filter(
                              (item) => item.key !== asset.key,
                            );
                            change({ references: incoming.current });
                          }}
                        >
                          <X size={14} />
                        </button>
                        <div className={styles.referenceOrder}>
                          {[-1, 1].map((delta) => (
                            <button
                              type="button"
                              key={delta}
                              disabled={
                                index + delta < 0 ||
                                index + delta >= input.references.length
                              }
                              aria-label={`Move reference ${asset.name} ${delta < 0 ? "earlier" : "later"}`}
                              onClick={() => {
                                const refs = [...input.references];
                                [refs[index], refs[index + delta]] = [
                                  refs[index + delta],
                                  refs[index],
                                ];
                                incoming.current = refs;
                                change({ references: refs });
                              }}
                            >
                              {delta < 0 ? (
                                <ArrowLeft size={13} />
                              ) : (
                                <ArrowRight size={13} />
                              )}
                            </button>
                          ))}
                        </div>
                      </figure>
                    ))}
                  </div>
                  <p>
                    References are sent in this order. Each original must be no
                    larger than 50 MB.
                  </p>
                  <button
                    type="button"
                    className="suite-button"
                    disabled={input.references.length >= 30}
                    onClick={() => imagePicker.current?.click()}
                  >
                    <ImagePlus size={14} />
                    Upload reference images
                  </button>
                  <input
                    hidden
                    multiple
                    ref={imagePicker}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    aria-label="Upload connected Genjutsu reference images"
                    onChange={(event) => {
                      if (event.target.files)
                        void receiver.useFiles(event.target.files, "reference");
                      event.target.value = "";
                    }}
                  />
                </div>
                <label>
                  Creative direction · optional
                  <textarea
                    aria-label="Connected Genjutsu creative direction"
                    rows={5}
                    maxLength={5000}
                    value={input.prompt}
                    onChange={(event) => change({ prompt: event.target.value })}
                  />
                </label>
                <div>
                  <p className={styles.hint}>
                    Creative directions · written by Particl
                  </p>
                  <div className={styles.chips}>
                    {SUBATOMIK_DIRECTIONS.map(([name, prompt]) => (
                      <button
                        type="button"
                        key={name}
                        onClick={() => change({ prompt })}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                </div>
                <label>
                  Output quality
                  <select
                    aria-label="Connected Genjutsu output quality"
                    value={input.resolution}
                    onChange={(event) =>
                      change({
                        resolution: event.target
                          .value as Creative["resolution"],
                      })
                    }
                  >
                    {CONSUMER_GENJUTSU_RESOLUTIONS.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
              </fieldset>
              <label className={styles.confirm}>
                <input
                  type="checkbox"
                  checked={disclosed}
                  disabled={blocked || !input.source || !capability?.connected}
                  onChange={(event) => setDisclosed(event.target.checked)}
                />
                Copy these selected originals to my connected account to obtain
                this quote.
              </label>
              <div className={styles.actions}>
                <button
                  type="button"
                  className="suite-primary"
                  disabled={!canQuote}
                  onClick={() => void act("quote")}
                >
                  {busy === "quote"
                    ? "Copying originals and reading price…"
                    : "Get connected Genjutsu quote"}
                </button>
                <button
                  type="button"
                  className="suite-button"
                  disabled={blocked}
                  onClick={() => void refresh()}
                >
                  <RefreshCw size={14} />
                  Refresh saved Genjutsu jobs
                </button>
              </div>
              {unresolved && (
                <p role="status" className={styles.hint}>
                  A saved submission needs reconciliation. It will not be
                  submitted again; check its existing receipt before starting
                  another.
                </p>
              )}
              {!!missing.length && (
                <button
                  type="button"
                  className="suite-button"
                  disabled={blocked}
                  onClick={() => void act("status", null, missing[0])}
                >
                  Recover earlier Genjutsu submission
                </button>
              )}
              {selected?.status === "quoted" && (
                <div
                  className={styles.quote}
                  aria-label="Connected Genjutsu quote"
                >
                  <strong>
                    {selected.quoteCredits} connected credits ·{" "}
                    {selected.workspaceName}
                  </strong>
                  <small>Wallet {selected.workspaceId}</small>
                  <p>
                    {GENJUTSU_LABELS[selected.input.variant]} ·{" "}
                    {selected.input.resolution} ·{" "}
                    {selected.input.references.length} image references
                  </p>
                  <p>
                    {matches
                      ? "Review the selected originals, prompt and wallet before approving."
                      : "The settings changed. Request a fresh quote before generating."}
                  </p>
                  <p>
                    {selected.quoteExpiresAt > clock
                      ? `Quote valid until ${new Date(selected.quoteExpiresAt).toLocaleTimeString()}.`
                      : "This quote expired."}{" "}
                    The connected account’s active wallet is shared across its
                    connected clients; Particl checks it again before
                    submission.
                  </p>
                  <label className={styles.confirm}>
                    <input
                      type="checkbox"
                      checked={approved}
                      disabled={
                        !matches || blocked || attempts.includes(selected.id)
                      }
                      onChange={(event) => setApproved(event.target.checked)}
                    />
                    Charge {selected.quoteCredits} connected credits to{" "}
                    {selected.workspaceName} for this Genjutsu generation.
                  </label>
                  <button
                    type="button"
                    className="suite-primary"
                    disabled={!canSubmit}
                    onClick={() => void act("submit")}
                  >
                    {busy === "submit"
                      ? "Submitting once…"
                      : `Generate Genjutsu · ${selected.quoteCredits} connected credits`}
                  </button>
                </div>
              )}
            </>
          )}
          {notice && (
            <p className={styles.notice} role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </section>
        <aside
          className={`suite-panel ${styles.library}`}
          aria-label="Connected Genjutsu workspace assets"
        >
          <div className="suite-section-heading">
            <div>
              <h2>Workspace assets</h2>
              <p>Choose a source video and ordered image references.</p>
            </div>
          </div>
          <label className={styles.search}>
            Search assets
            <input
              aria-label="Search connected Genjutsu assets"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <GenAssetLibrary
            workbenchProjectId={project.id}
            projectName={project.name}
            allowWorkspaceBrowse
            initialBrowseScope="workspace"
            search={search}
            onUseAsset={(asset) => void receiver.useAsset(asset)}
            onUseReference={(asset) =>
              void receiver.useAsset(libraryInput(asset))
            }
            onUsePrompt={(take) =>
              change({ prompt: take.prompt.slice(0, 5000) })
            }
            onEdit={(asset) => libraryTool(asset, "edit")}
            onUpscale={(asset) => libraryTool(asset, "upscale")}
          />
        </aside>
      </div>
      <section
        className={`suite-panel ${styles.results}`}
        aria-label="Connected Genjutsu project results"
      >
        <div className="suite-section-heading">
          <div>
            <h2>Connected account results</h2>
            <p>
              Your account’s saved Genjutsu jobs in this project. Active
              submissions stay pinned; approved quotes use connected credits.
            </p>
          </div>
        </div>
        {!jobs.length ? (
          <p className={styles.hint}>
            {busy === "refresh"
              ? "Loading saved jobs…"
              : !capability
                ? "Saved job history is unavailable. Refresh saved jobs to try again."
                : "No saved connected Genjutsu jobs in this project."}
          </p>
        ) : (
          <>
            <div className={styles.takeList}>
              {jobs.map((job) => (
                <button
                  type="button"
                  key={job.id}
                  aria-pressed={selectedId === job.id}
                  onClick={() => {
                    setSelectedId(job.id);
                    setApproved(false);
                  }}
                >
                  <strong>{GENJUTSU_LABELS[job.input.variant]}</strong>
                  <span>
                    {job.status === "completed"
                      ? original(job)
                        ? "Original ready"
                        : job.originalAvailability === "deleted"
                          ? "Original deleted"
                          : "Original unavailable"
                      : job.status}{" "}
                    · {job.quoteCredits} connected credits
                  </span>
                </button>
              ))}
            </div>
            {selected && (
              <>
                <p className={styles.hint}>
                  {selected.workspaceName} · {selected.input.resolution} ·{" "}
                  {selected.input.references.length} references ·{" "}
                  {selected.input.prompt || "No additional prompt"}
                </p>
                <SyncedVideoComparison
                  key={`${selected.id}:${!!output}`}
                  before={mediaUrl(selected.input.source)}
                  after={output ? `${output.url}?stream=1` : null}
                  afterLabel={GENJUTSU_LABELS[selected.input.variant]}
                  unavailable={
                    selected.status === "completed"
                      ? selected.originalAvailability === "deleted"
                        ? "The original was deleted; the job receipt remains available."
                        : "The completed original is currently unavailable."
                      : "The retained result appears after generation and original collection finish."
                  }
                />
                <div className={styles.actions}>
                  <button
                    type="button"
                    className="suite-button"
                    disabled={blocked || unresolved}
                    onClick={() => void recreate(selected)}
                  >
                    Recreate with fresh quote
                  </button>
                  {(["accepted", "uncertain", "dispatching"].includes(
                    selected.status,
                  ) ||
                    attempts.includes(selected.id)) && (
                    <button
                      type="button"
                      className="suite-button"
                      disabled={blocked || clock < (nextPoll[selected.id] ?? 0)}
                      onClick={() => void act("status", selected)}
                    >
                      {clock < (nextPoll[selected.id] ?? 0)
                        ? `Check again in ${Math.ceil(((nextPoll[selected.id] ?? 0) - clock) / 1000)}s`
                        : "Check saved Genjutsu result"}
                    </button>
                  )}
                  {output && (
                    <>
                      <a
                        className="suite-button"
                        href={`${output.url}?download=1`}
                        download
                      >
                        Download original
                      </a>
                      <button
                        type="button"
                        className="suite-primary"
                        disabled={blocked}
                        onClick={() => openInEdit(selected, output)}
                      >
                        Use in Edit
                      </button>
                    </>
                  )}
                </div>
                <details className={styles.guide}>
                  <summary>Saved job receipt</summary>
                  <pre className={styles.receipt}>
                    {JSON.stringify(
                      selected.result ??
                        selected.providerReceipt ?? {
                          id: selected.id,
                          status: selected.status,
                        },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </>
            )}
          </>
        )}
      </section>
      <SuiteAgentPanel
        suite="subatomik"
        project={project}
        scope={scope}
        enabled={!blocked && !unresolved}
        onApply={(plan: Plan) =>
          void mutateProject((latest) =>
            applySuiteAgentPlan(latest, plan, () => crypto.randomUUID()),
          )
        }
      />
      {preview && (
        <ReferenceImagePreview
          asset={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
