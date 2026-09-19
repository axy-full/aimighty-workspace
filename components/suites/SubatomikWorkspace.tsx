"use client";
/* eslint-disable @next/next/no-img-element -- Private originals need the browser's authenticated same-origin request. */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Film,
  ImagePlus,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import { useDraft } from "@/lib/useDraft";
import { usePaidAction } from "@/lib/usePaidAction";
import { useUploadFile } from "@/lib/useUploadFile";
import { useMoney } from "@/lib/price";
import { usePageTitle } from "@/lib/usePageTitle";
import {
  useGenAssetInput,
  resolveGenInput,
  GEN_ASSETS_CHANGED,
  type GenInputAsset,
} from "@/lib/genAssetInput";
import { libraryInput, type LibraryAsset } from "@/lib/genLibrary";
import {
  GENJUTSU_DESCRIPTIONS,
  GENJUTSU_LABELS,
  GENJUTSU_LIMITS,
  GENJUTSU_MODELS,
  GENJUTSU_RESOLUTIONS,
  genjutsuVariantForModel,
  isGenjutsuModel,
  type GenjutsuResolution,
  type GenjutsuVariant,
} from "@/lib/genjutsuTypes";
import { generatedReferenceSeconds } from "@/lib/referenceDuration";
import { fileProjectUpload } from "@/lib/workbench/project-library-client";
import { draftRequest, writeDraft } from "@/lib/workbench/draft-request";
import { applySuiteAgentPlan } from "@/lib/workbench/suite-agent-plan";
import { suiteHref } from "@/lib/suites";
import type { Project, Plan } from "@/lib/workbench/studio";
import type { Generation } from "@/lib/jobs";
import type { AdmissionQuote } from "@/lib/admissionTypes";
import GenAssetLibrary from "@/components/make/GenAssetLibrary";
import { projectAssetFromLibrary } from "@/components/workbench/ProjectLibraryPage";
import { ToastHost } from "@/components/ui/Toast";
import { SuiteAgentPanel } from "./SuiteAgentPanel";
import { useSuiteProject } from "./SuiteProjectContext";
import { SyncedVideoComparison } from "./SyncedVideoComparison";
import { ReferenceImagePreview } from "./ReferenceImagePreview";
import { FrameExtractControls } from "./FrameExtractControls";
import { ConsumerGenjutsu } from "./ConsumerGenjutsu";
import { ConsumerShorts } from "./ConsumerShorts";
import { recreationProblem, recreationSettings } from "./subatomik-recreate";
import styles from "./subatomik.module.css";
import { SUBATOMIK_DIRECTIONS } from "./subatomik-directions";

type DraftResponse = {
  project: Project | null;
  projects: { id: string; name: string }[];
  revision: number;
};
type CreativeDraft = {
  source: GenInputAsset | null;
  references: GenInputAsset[];
  prompt: string;
  resolution: GenjutsuResolution;
};
const EMPTY: CreativeDraft = {
  source: null,
  references: [],
  prompt: "",
  resolution: "720p",
};

const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function safeAsset(
  value: unknown,
  kind: "video" | "image",
): GenInputAsset | null {
  if (
    !record(value) ||
    !validId(value.id) ||
    !["upload", "generation"].includes(String(value.origin)) ||
    value.kind !== kind
  )
    return null;
  const origin = value.origin as "upload" | "generation";
  return {
    key: `${origin}:${value.id}`,
    id: value.id,
    origin,
    kind,
    name:
      typeof value.name === "string"
        ? value.name.slice(0, 200)
        : "Saved original",
    url: `/${origin === "upload" ? "api/uploads" : "api/media"}/${encodeURIComponent(value.id)}`,
    mime: typeof value.mime === "string" ? value.mime : "",
    bytes: 0,
    width: null,
    height: null,
    seconds:
      typeof value.seconds === "number" && Number.isFinite(value.seconds)
        ? value.seconds
        : null,
    sha256: "",
  };
}
function creativeDraft(value: unknown): CreativeDraft {
  if (!record(value)) return EMPTY;
  const refs = Array.isArray(value.references)
    ? value.references
        .map((item) => safeAsset(item, "image"))
        .filter((item): item is GenInputAsset => !!item)
    : [];
  return {
    source: safeAsset(value.source, "video"),
    references: [
      ...new Map(refs.map((item) => [item.key, item])).values(),
    ].slice(0, GENJUTSU_LIMITS.maxImages),
    prompt:
      typeof value.prompt === "string"
        ? value.prompt.slice(0, GENJUTSU_LIMITS.maxPromptChars)
        : "",
    resolution: value.resolution === "480p" ? "480p" : "720p",
  };
}
function sourceUrl(value: Record<string, unknown>) {
  return validId(value.sourceGenId)
    ? `/api/media/${encodeURIComponent(value.sourceGenId)}`
    : validId(value.sourceUploadId)
      ? `/api/uploads/${encodeURIComponent(value.sourceUploadId)}`
      : null;
}
const price = (quote: AdmissionQuote) =>
  quote.unit === "cr"
    ? `${quote.price.toLocaleString()} cr`
    : `$${quote.price.toFixed(2)}`;

type BillingAccount = "particl" | "higgsfield";
type ConnectionStatus = { connected?: boolean; requiresReconnect?: boolean };

export default function SubatomikWorkspace() {
  usePageTitle("Subatomik Viral Studio");
  const session = useSession(),
    query = useSearchParams(),
    captured = useSuiteProject();
  const projectId = query.get("project") || captured.projectId;
  // Shorts runs only on the connected account; the other pages are Genjutsu variants.
  const shorts = query.get("page") === "shorts";
  const variant: GenjutsuVariant =
    query.get("page") === "object-swap" ? "object-swap" : "motion-transfer";
  // Billing is folded in silently: with a connected account the owner's
  // connected credits are used by default. `?account=particl` is an explicit,
  // unadvertised override to Particl workspace (Cloud) billing;
  // `?account=higgsfield` remains valid for older links.
  const requested = query.get("account");
  const explicit: BillingAccount | null =
    requested === "higgsfield"
      ? "higgsfield"
      : requested === "particl"
        ? "particl"
        : null;
  const connection = useApi<ConnectionStatus>(
    session.signedIn && session.owner && session.requestScope && !explicit
      ? "/api/higgsfield/consumer/connection"
      : null,
    0,
    session.requestScope,
  );
  const connected =
    connection.data?.connected === true &&
    connection.data.requiresReconnect !== true;
  const account: BillingAccount | null = explicit
    ? explicit
    : !session.owner
      ? "particl"
      : connection.data || connection.error
        ? connected
          ? "higgsfield"
          : "particl"
        : null;
  const drafts = useApi<DraftResponse>(
    session.requestScope
      ? `/api/workbench/projects${projectId ? `?id=${encodeURIComponent(projectId)}` : ""}`
      : null,
    0,
    session.requestScope,
  );
  const project =
    projectId && drafts.data?.project?.id === projectId
      ? drafts.data.project
      : null;
  return (
    <ToastHost>
      <div className={`suite-workspace ${styles.workspace}`}>
        <header className="suite-page-intro">
          <div>
            <span className="suite-kicker">
              <i className="suite-dot" style={{ background: "#D48CF5" }} />
              Subatomik{project ? ` / ${project.name}` : ""}
            </span>
            <h1>Subatomik Viral Studio</h1>
            <p>
              Rework a movement. Recast a subject. Make a familiar frame feel
              new.
            </p>
          </div>
          <span className="suite-badge">{shorts || account === "higgsfield" ? "Connected account" : "Transform"}</span>
        </header>
        {!session.signedIn ? (
          <section className="suite-panel">
            <h2>Bring your next visual idea.</h2>
            <p>
              Sign in to choose a project, reuse original assets and review
              generation costs.
            </p>
            <Link className="suite-button" href="/login">
              Sign in
            </Link>
          </section>
        ) : drafts.error ? (
          <div className="suite-alert" role="alert">
            {drafts.error}{" "}
            <button
              className="suite-button"
              onClick={() => void drafts.refresh()}
            >
              Retry projects
            </button>
          </div>
        ) : !drafts.data || !captured.ready ? (
          <p role="status">Opening the selected project…</p>
        ) : !project?.productionProjectId || !session.requestScope ? (
          <section className="suite-panel">
            <h2>Choose a saved project</h2>
            <p>
              Your sources, generation costs and finished originals stay with
              this project.
            </p>
            <div className={styles.actions}>
              {drafts.data.projects.map((item) => (
                <Link
                  className="suite-button"
                  key={item.id}
                  href={suiteHref("subatomik", item.id, variant)}
                >
                  {item.name}
                </Link>
              ))}
              <Link className="suite-button" href="/workbench?new=1">
                Create a project
              </Link>
            </div>
          </section>
        ) : (
          <>
            {shorts ? (
              account === null ? (
                <p role="status">Checking the connected account…</p>
              ) : account === "higgsfield" ? (
                <ConsumerShorts
                  key={`${session.requestScope}:${project.id}:shorts`}
                  project={project}
                  scope={session.requestScope}
                  refreshProject={drafts.refresh}
                />
              ) : (
                <section className="suite-panel" aria-label="Shorts on the connected account">
                  <h2>Shorts</h2>
                  <p className={styles.hint}>
                    {session.owner ? (
                      <>Shorts run on the owner’s connected account. Connect one in <a href="/settings#engines">Workspace settings</a>.</>
                    ) : (
                      "Shorts run on the workspace owner’s connected account."
                    )}
                  </p>
                </section>
              )
            ) : account === null ? (
              <p role="status">Checking the connected account…</p>
            ) : account === "higgsfield" ? (
              <ConsumerGenjutsu
                key={`${session.requestScope}:${project.id}:${variant}:consumer`}
                project={project}
                scope={session.requestScope}
                variant={variant}
                refreshProject={drafts.refresh}
              />
            ) : (
              <>
                {session.owner && !explicit && (
                  <p className={styles.hint} role="status">
                    {connection.error
                      ? "The connected account could not be checked, so this project bills the Particl workspace for now."
                      : connection.data?.requiresReconnect
                        ? "Reconnect your account in "
                        : "No connected account yet. Connect one in "}
                    {!connection.error && (
                      <>
                        <a href="/settings#engines">Workspace settings</a> to
                        generate with connected credits. Until then this
                        project bills the Particl workspace.
                      </>
                    )}
                  </p>
                )}
                <Studio
                  key={`${session.requestScope}:${project.id}:${variant}:particl`}
                  project={project}
                  scope={session.requestScope}
                  variant={variant}
                  refreshProject={drafts.refresh}
                />
              </>
            )}
            {account !== null && !shorts && (
              <details className={styles.advanced}>
                <summary>Advanced</summary>
                <p>
                  {account === "higgsfield"
                    ? "This project generates with the owner’s connected credits."
                    : "This project bills the Particl workspace."}{" "}
                  {account === "higgsfield" ? (
                    <Link
                      href={`${suiteHref("subatomik", project.id, variant)}&account=particl`}
                    >
                      Use Particl workspace billing instead
                    </Link>
                  ) : session.owner ? (
                    <Link
                      href={`${suiteHref("subatomik", project.id, variant)}&account=higgsfield`}
                    >
                      Use connected credits instead
                    </Link>
                  ) : null}
                </p>
              </details>
            )}
          </>
        )}
      </div>
    </ToastHost>
  );
}

function Studio({
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
  const router = useRouter(),
    query = useSearchParams(),
    upload = useUploadFile(),
    money = useMoney();
  // Studio only renders on the explicit `?account=particl` override or when
  // no account is connected; keep that override on in-page navigation.
  const studioHref = (page: GenjutsuVariant) =>
    suiteHref("subatomik", project.id, page) +
    (query.get("account") === "particl" ? "&account=particl" : "");
  const draft = useDraft<CreativeDraft>(
      `subatomik:${project.id}:${variant}`,
      EMPTY,
    ),
    input = creativeDraft(draft.value);
  const paid = usePaidAction(`subatomik:genjutsu:${project.id}`, true, {
    signedIn: true,
    requestScope: scope,
  });
  const [reviewed, setReviewed] = useState<{
    body: string;
    quote: AdmissionQuote;
  } | null>(null);
  const [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [search, setSearch] = useState(""),
    [selectedId, setSelectedId] = useState("");
  const [cancelRequested, setCancelRequested] = useState<string[]>([]);
  const [previewImage, setPreviewImage] = useState<GenInputAsset | null>(null);
  const [frameBusy, setFrameBusy] = useState(false);
  const recreationHandled = useRef(""),
    writable = useRef(false);
  const sourcePicker = useRef<HTMLInputElement>(null),
    imagePicker = useRef<HTMLInputElement>(null),
    library = useRef<HTMLDivElement>(null),
    intake = useRef<GenInputAsset[]>(input.references);
  const live = useRef(false),
    epoch = useRef(0),
    lock = useRef(false);
  useEffect(() => {
    live.current = true;
    const token = ++epoch.current;
    return () => {
      live.current = false;
      epoch.current = token + 1;
    };
  }, []);
  useEffect(() => {
    intake.current = input.references;
  }, [input.references]);
  const history = useApi<{ generations: Generation[] }>(
    `/api/workbench/library?projectId=${encodeURIComponent(project.id)}&source=generations&limit=500`,
    15000,
    scope,
  );
  const takes = (history.data?.generations ?? []).filter(
    (take) =>
      take.projectId === project.productionProjectId &&
      isGenjutsuModel(take.model),
  );
  const selected =
    takes.find((take) => take.id === selectedId) ??
    takes.find((take) => take.status === "succeeded" && take.storedUrl) ??
    takes[0];
  const saved = paid.pending
    ? (JSON.parse(paid.pending.body) as Record<string, unknown>)
    : null;
  const savedVariant =
    saved && typeof saved.model === "string"
      ? genjutsuVariantForModel(saved.model)
      : null;
  const recoverable =
    !!saved &&
    !!savedVariant &&
    saved.task === "genjutsu" &&
    saved.workbenchProjectId === project.id &&
    saved.projectId === project.productionProjectId;
  const body = {
    model: GENJUTSU_MODELS[variant],
    task: "genjutsu",
    sourceUploadId:
      input.source?.origin === "upload" ? input.source.id : undefined,
    sourceGenId:
      input.source?.origin === "generation" ? input.source.id : undefined,
    references: input.references.map((asset) => ({
      ...(asset.origin === "upload"
        ? { uploadId: asset.id }
        : { genId: asset.id }),
      role: "reference_image",
    })),
    resolution: input.resolution,
    prompt: input.prompt,
    projectId: project.productionProjectId,
    workbenchProjectId: project.id,
    refine: false,
  };
  const bodyKey = JSON.stringify(body),
    quote = reviewed?.body === bodyKey ? reviewed.quote : null;
  const locked = busy || frameBusy || !!paid.pending || !!paid.error;
  useEffect(() => {
    writable.current = !paid.pending && !paid.error;
  }, [paid.pending, paid.error]);
  function change(patch: Partial<CreativeDraft>) {
    if (locked) return;
    draft.set({ ...input, ...patch });
    setReviewed(null);
    setConfirmed(false);
    setError("");
  }
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
      if (
        target === "reference" &&
        intake.current.length >= GENJUTSU_LIMITS.maxImages
      )
        throw Error(
          "Use up to eight image references. Remove an image before adding another.",
        );
    },
    upload: async (file) => {
      const original = await upload(file, "chat");
      await fileProjectUpload(project.id, original.id, scope);
      return original;
    },
    onAsset(asset, target) {
      if (
        (target === "source" && asset.kind !== "video") ||
        (target === "reference" && asset.kind !== "image")
      )
        throw Error(
          target === "source"
            ? "Choose a video for the source."
            : "Choose a still image for a reference.",
        );
      if (asset.kind === "video") {
        if (
          asset.seconds != null &&
          (asset.seconds < GENJUTSU_LIMITS.minSeconds ||
            asset.seconds > GENJUTSU_LIMITS.maxSeconds)
        )
          throw Error("Choose a source clip between 1 and 30 seconds.");
        draft.set((previous) => ({
          ...creativeDraft(previous),
          source: asset,
        }));
      } else if (asset.kind === "image") {
        if (!intake.current.some((item) => item.key === asset.key)) {
          if (intake.current.length >= GENJUTSU_LIMITS.maxImages)
            throw Error(
              "Use up to eight image references. Remove an image before adding another.",
            );
          intake.current = [...intake.current, asset];
          draft.set((previous) => ({
            ...creativeDraft(previous),
            references: intake.current,
          }));
        }
      } else throw Error("Choose a source video or still-image reference.");
      setReviewed(null);
      setConfirmed(false);
      setError("");
      setNotice(
        `${asset.name} ${asset.kind === "video" ? "selected as source" : "added as a reference"}.`,
      );
    },
    onError: setError,
  });
  const blocked = locked || receiver.busy;
  function moveReference(index: number, delta: number) {
    if (
      blocked ||
      index + delta < 0 ||
      index + delta >= input.references.length
    )
      return;
    const references = [...input.references];
    [references[index], references[index + delta]] = [
      references[index + delta],
      references[index],
    ];
    intake.current = references;
    change({ references });
  }
  async function restoreTake(id: string) {
    if (lock.current || blocked) return;
    lock.current = true;
    const token = epoch.current;
    setBusy(true);
    setError("");
    setReviewed(null);
    setConfirmed(false);
    try {
      if (!validId(id))
        throw Error("Choose a saved transform take to recreate.");
      const response = await fetch(
        `/api/jobs/${encodeURIComponent(id)}?sync=0`,
        {
          cache: "no-store",
          headers: { "X-Workbench-Scope": scope },
          signal: AbortSignal.timeout(20000),
        },
      );
      const value = await response.json().catch(() => null),
        take = value?.generation as Generation | undefined;
      if (
        !response.ok ||
        !take ||
        take.id !== id ||
        take.projectId !== project.productionProjectId ||
        (take.params?.workbenchProjectId != null &&
          take.params.workbenchProjectId !== project.id)
      )
        throw Error(
          "This saved take is not available in the selected project.",
        );
      const settings = recreationSettings(take);
      if (!live.current || token !== epoch.current || !writable.current) return;
      if (settings.variant !== variant) {
        router.replace(
          `${studioHref(settings.variant)}&recreate=${encodeURIComponent(id)}`,
        );
        return;
      }
      const originals = await Promise.all(
        [settings.source, ...settings.references].map((key) =>
          resolveGenInput(key, scope),
        ),
      );
      if (!live.current || token !== epoch.current || !writable.current) return;
      const source = originals[0],
        references = originals.slice(1);
      if (
        source.kind !== "video" ||
        references.some((asset) => asset.kind !== "image")
      )
        throw Error(
          "One of this take’s saved originals is no longer the expected media type.",
        );
      if (
        source.seconds != null &&
        (source.seconds < GENJUTSU_LIMITS.minSeconds ||
          source.seconds > GENJUTSU_LIMITS.maxSeconds)
      )
        throw Error(
          "The saved source is outside the supported 1–30 second range.",
        );
      intake.current = references;
      draft.set({
        source,
        references,
        prompt: settings.prompt,
        resolution: settings.resolution,
      });
      setNotice(
        "Saved settings and original references restored. Review a fresh quote before generating another take.",
      );
      if (query.has("recreate"))
        router.replace(studioHref(variant));
      sourcePicker.current
        ?.closest("section")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (cause) {
      if (live.current && token === epoch.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The original settings could not be restored. Your current creative draft is unchanged.",
        );
    } finally {
      lock.current = false;
      if (live.current && token === epoch.current) setBusy(false);
    }
  }
  useEffect(() => {
    const id = query.get("recreate");
    if (!id || blocked || recreationHandled.current === id) return;
    recreationHandled.current = id;
    void restoreTake(id);
  });
  function libraryTool(asset: LibraryAsset, task: "edit" | "upscale") {
    const kind =
      asset.origin === "generation" ? asset.value.kind : asset.value.kind;
    router.push(
      `/generate?${new URLSearchParams({ project: project.id, mode: kind === "video" ? "video" : "images", ...(kind === "video" || task === "upscale" ? { task, source: `${asset.origin}:${asset.value.id}` } : { ref: `${asset.origin}:${asset.value.id}` }) })}`,
    );
  }
  async function review() {
    if (blocked || lock.current || !input.source) return;
    lock.current = true;
    const token = epoch.current;
    setBusy(true);
    setError("");
    setReviewed(null);
    setConfirmed(false);
    try {
      const response = await fetch("/api/generate/quote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Workbench-Scope": scope,
        },
        body: bodyKey,
        signal: AbortSignal.timeout(60000),
      });
      const value = await response.json().catch(() => null);
      if (!response.ok)
        throw Error(
          value?.error ||
            "The source and current provider price could not be verified.",
        );
      if (
        !record(value) ||
        !Number.isSafeInteger(value.estimatedCredits) ||
        Number(value.estimatedCredits) < 0 ||
        typeof value.fingerprint !== "string" ||
        !value.fingerprint ||
        typeof value.price !== "number" ||
        !Number.isFinite(value.price) ||
        value.price < 0 ||
        !["cr", "usd"].includes(String(value.unit))
      )
        throw Error(
          "The price response was incomplete. Review the cost again.",
        );
      if (live.current && token === epoch.current)
        setReviewed({ body: bodyKey, quote: value as AdmissionQuote });
    } catch (cause) {
      if (live.current && token === epoch.current)
        setError(
          cause instanceof Error ? cause.message : "Cost review failed.",
        );
    } finally {
      lock.current = false;
      if (live.current && token === epoch.current) setBusy(false);
    }
  }
  async function submit() {
    if (
      lock.current ||
      busy ||
      receiver.busy ||
      paid.error ||
      (paid.pending ? !recoverable : !quote || !confirmed)
    )
      return;
    lock.current = true;
    const token = epoch.current;
    setBusy(true);
    setError("");
    try {
      const result = await paid.run<{ id: string }>(
        "/api/generate",
        saved ?? {
          ...body,
          maxCredits: quote!.estimatedCredits,
          quoteFingerprint: quote!.fingerprint,
        },
        {
          context: {
            sourceName: input.source?.name,
            price: quote ? price(quote) : undefined,
            variant,
          },
        },
      );
      if (!validId(result.data.id))
        throw Error("The saved request needs review in Activity.");
      if (live.current && token === epoch.current) {
        setSelectedId(result.data.id);
        setReviewed(null);
        setConfirmed(false);
        setNotice(
          "Transform generation queued. Follow this exact job in Project results.",
        );
        void history.refresh();
        window.dispatchEvent(
          new CustomEvent(GEN_ASSETS_CHANGED, { detail: { scope } }),
        );
      }
    } catch (cause) {
      if (live.current && token === epoch.current) {
        setReviewed(null);
        setConfirmed(false);
        setError(
          cause instanceof Error
            ? cause.message
            : "Recover the saved generation request.",
        );
      }
    } finally {
      lock.current = false;
      if (live.current && token === epoch.current) setBusy(false);
    }
  }
  async function mutateProject(
    apply: (latest: Project) => Project,
    after?: () => void,
  ) {
    if (lock.current) return;
    lock.current = true;
    const token = epoch.current;
    setBusy(true);
    setError("");
    try {
      const latest = await draftRequest<DraftResponse>(
        `/api/workbench/projects?id=${encodeURIComponent(project.id)}`,
        scope,
      );
      if (!live.current || token !== epoch.current) return;
      if (
        latest.project?.id !== project.id ||
        latest.project.productionProjectId !== project.productionProjectId
      )
        throw Error(
          "The selected project changed. Open it again before saving.",
        );
      await writeDraft("/api/workbench", scope, {
        project: apply(latest.project),
        revision: latest.revision,
      });
      if (live.current && token === epoch.current) {
        await refreshProject();
        if (live.current && token === epoch.current) after?.();
      }
    } catch (cause) {
      if (live.current && token === epoch.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The project could not be updated.",
        );
    } finally {
      lock.current = false;
      if (live.current && token === epoch.current) setBusy(false);
    }
  }
  function applyPlan(plan: Plan) {
    void mutateProject(
      (latest) => applySuiteAgentPlan(latest, plan, () => crypto.randomUUID()),
      () =>
        setNotice(
          "Agent actions saved as editable nodes in Rig. Each render has a separate quote.",
        ),
    );
  }
  function openInEdit(take: Generation) {
    if (take.status !== "succeeded" || !take.storedUrl) return;
    void mutateProject(
      (latest) => {
        const asset =
          latest.assets.find((item) => item.generationId === take.id) ??
          projectAssetFromLibrary({ origin: "generation", value: take });
        if (
          !latest.assets.some((item) => item.id === asset.id) &&
          latest.assets.length >= 500
        )
          throw Error(
            "This project already has 500 assets. Remove an unused asset before adding this take.",
          );
        const shots = latest.shots.some((item) => item.assetId === asset.id)
          ? latest.shots
          : [
              ...latest.shots,
              {
                id: crypto.randomUUID(),
                name: asset.name.slice(0, 200),
                assetId: asset.id,
                duration: Math.max(
                  1,
                  Math.round(
                    (generatedReferenceSeconds(take.params) ?? 5) * latest.fps,
                  ),
                ),
                sourceIn: 0,
                note: asset.description,
              },
            ];
        return {
          ...latest,
          assets: latest.assets.some((item) => item.id === asset.id)
            ? latest.assets
            : [...latest.assets, asset],
          shots,
        };
      },
      () => router.push(suiteHref("particl", project.id, "edit")),
    );
  }
  async function refreshResults() {
    if (lock.current) return;
    lock.current = true;
    const token = epoch.current;
    setBusy(true);
    setError("");
    try {
      const active = takes.filter((take) =>
        ["queued", "running", "submitted", "processing"].includes(take.status),
      );
      for (const take of active.slice(0, 4)) {
        const response = await fetch(
          `/api/jobs/${encodeURIComponent(take.id)}`,
          {
            cache: "no-store",
            headers: { "X-Workbench-Scope": scope },
            signal: AbortSignal.timeout(60000),
          },
        );
        if (!response.ok)
          throw Error(
            "A saved job could not be refreshed. Its original request is retained.",
          );
      }
      if (live.current && token === epoch.current) await history.refresh();
    } catch (cause) {
      if (live.current && token === epoch.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Results could not be refreshed.",
        );
    } finally {
      lock.current = false;
      if (live.current && token === epoch.current) setBusy(false);
    }
  }
  async function requestCancellation(take: Generation) {
    if (
      lock.current ||
      take.status !== "queued" ||
      cancelRequested.includes(take.id)
    )
      return;
    lock.current = true;
    const token = epoch.current;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/generations/${encodeURIComponent(take.id)}/cancel`,
        {
          method: "POST",
          headers: { "X-Workbench-Scope": scope },
          signal: AbortSignal.timeout(60000),
        },
      );
      const result = await response.json().catch(() => null);
      if (!response.ok)
        throw Error(
          result?.error ||
            "Cancellation could not be confirmed. Refresh this existing take before trying again.",
        );
      if (live.current && token === epoch.current) {
        if (result?.status === "requested") {
          setCancelRequested((previous) => [
            ...new Set([...previous, take.id]),
          ]);
          setNotice(
            "Cancellation requested. Waiting for the provider to confirm the outcome.",
          );
        } else
          setNotice(
            "The take’s status changed before cancellation. Review its current result.",
          );
        await history.refresh();
      }
    } catch (cause) {
      if (live.current && token === epoch.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Cancellation could not be confirmed.",
        );
    } finally {
      lock.current = false;
      if (live.current && token === epoch.current) setBusy(false);
    }
  }
  const previewSource = saved ? sourceUrl(saved) : input.source?.url;
  const before = selected
    ? sourceUrl({
        ...selected.params,
        ...(selected.sourceGenId ? { sourceGenId: selected.sourceGenId } : {}),
      })
    : null;
  const readyOutput = selected?.status === "succeeded" && !!selected.storedUrl;
  const recreationUnavailable = selected ? recreationProblem(selected) : null;
  return (
    <>
      <div className={styles.columns}>
        <section
          className={`suite-panel ${styles.creator}`}
          aria-label="Transform creation"
        >
          <div className="suite-section-heading">
            <div>
              <h2>{GENJUTSU_LABELS[savedVariant ?? variant]}</h2>
              <p>{GENJUTSU_DESCRIPTIONS[savedVariant ?? variant]}</p>
            </div>
            <Film size={21} />
          </div>
          <details className={styles.guide}>
            <summary>How it works</summary>
            <ol>
              <li>
                <strong>Choose the transformation.</strong> Motion Transfer uses
                the clip’s movement as direction for a new visual treatment.
                Object Swap focuses on replacing a subject, object or product
                within the shot.
              </li>
              <li>
                <strong>Select the original.</strong> Use one 1–30 second source
                video from this workspace, or upload your own.
              </li>
              <li>
                <strong>Set the visual direction.</strong> Add up to eight
                ordered still references for the subject, setting or style.
                Preview each original and move it earlier or later as needed.
              </li>
              <li>
                <strong>Describe the change.</strong> The prompt is optional.
                State what should change and what should stay consistent;
                Particl’s creative directions are editable starting points.
              </li>
              <li>
                <strong>Review and approve.</strong> Check the exact price
                before generation. Compare the retained result with its source,
                then recreate with a fresh quote or send it to Edit.
              </li>
            </ol>
            <p>
              <a
                className="suite-text-button"
                href="https://higgsfield.ai/ai/video?model=genjutsu"
                target="_blank"
                rel="noopener noreferrer"
              >
                External motion library <ArrowUpRight size={12} />
              </a>{" "}
              opens the provider’s external preset gallery. Its presets are not
              an embedded Particl catalog.
            </p>
          </details>
          <fieldset disabled={blocked} className={styles.form}>
            <div
              className={styles.source}
              aria-label="Transform source drop area"
              onDragOver={receiver.onDragOver}
              onDrop={(event) => receiver.onDrop(event, "source")}
            >
              <div className={styles.row}>
                <strong>Source video</strong>
                <span>1–30 seconds</span>
              </div>
              {previewSource ? (
                <>
                  <video
                    aria-label="Transform source preview"
                    src={previewSource}
                    controls
                    playsInline
                    preload="metadata"
                  />
                  <div className={styles.row}>
                    <span>
                      {String(
                        paid.pending?.context?.sourceName ??
                          input.source?.name ??
                          "Saved source",
                      )}
                    </span>
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
                  Drop a video here, choose it from the workspace library, or
                  upload an original.
                </p>
              )}
              <div className={styles.actions}>
                <button
                  type="button"
                  className="suite-button"
                  onClick={() => sourcePicker.current?.click()}
                >
                  <Upload size={14} />
                  Upload video
                </button>
                <button
                  type="button"
                  className="suite-button"
                  onClick={() =>
                    library.current?.scrollIntoView({
                      behavior: "smooth",
                      block: "start",
                    })
                  }
                >
                  Browse workspace assets
                </button>
              </div>
              <input
                hidden
                type="file"
                ref={sourcePicker}
                accept=".mp4,.mov,.webm,video/*"
                aria-label="Upload transform source video"
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
                disabled={
                  blocked ||
                  input.references.length >= GENJUTSU_LIMITS.maxImages
                }
                onBusyChange={setFrameBusy}
                onCreated={(asset) => {
                  if (
                    !live.current ||
                    lock.current ||
                    busy ||
                    paid.pending ||
                    paid.error ||
                    asset.kind !== "image" ||
                    intake.current.length >= GENJUTSU_LIMITS.maxImages ||
                    intake.current.some((item) => item.key === asset.key)
                  )
                    return;
                  intake.current = [...intake.current, asset];
                  draft.set((previous) => ({
                    ...creativeDraft(previous),
                    references: intake.current,
                  }));
                  setReviewed(null);
                  setConfirmed(false);
                  setError("");
                }}
              />
            </div>
            <div
              className={styles.source}
              aria-label="Transform reference drop area"
              onDragOver={receiver.onDragOver}
              onDrop={(event) => receiver.onDrop(event, "reference")}
            >
              <div className={styles.row}>
                <strong>Image references</strong>
                <span>
                  {saved && Array.isArray(saved.references)
                    ? saved.references.length
                    : input.references.length}{" "}
                  / 8 · optional
                </span>
              </div>
              {!saved && (
                <div className={styles.references}>
                  {input.references.map((asset, index) => (
                    <figure key={asset.key}>
                      <button
                        type="button"
                        className={styles.referencePreview}
                        aria-label={`Enlarge reference ${asset.name}`}
                        onClick={() => setPreviewImage(asset)}
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
                        onClick={() =>
                          change({
                            references: input.references.filter(
                              (item) => item.key !== asset.key,
                            ),
                          })
                        }
                      >
                        <X size={14} />
                      </button>
                      <div className={styles.referenceOrder}>
                        <button
                          type="button"
                          disabled={index === 0}
                          aria-label={`Move reference ${asset.name} earlier`}
                          onClick={() => moveReference(index, -1)}
                        >
                          <ArrowLeft size={13} />
                        </button>
                        <button
                          type="button"
                          disabled={index === input.references.length - 1}
                          aria-label={`Move reference ${asset.name} later`}
                          onClick={() => moveReference(index, 1)}
                        >
                          <ArrowRight size={13} />
                        </button>
                      </div>
                    </figure>
                  ))}
                </div>
              )}
              <p>
                {saved
                  ? "Reference identities are locked to the saved request."
                  : "Choose stills for the subject, product, wardrobe, setting or visual treatment."}
              </p>
              <button
                type="button"
                className="suite-button"
                disabled={input.references.length >= GENJUTSU_LIMITS.maxImages}
                onClick={() => imagePicker.current?.click()}
              >
                <ImagePlus size={14} />
                Upload reference images
              </button>
              <input
                hidden
                type="file"
                multiple
                ref={imagePicker}
                accept="image/png,image/jpeg,image/webp"
                aria-label="Upload transform reference images"
                onChange={(event) => {
                  if (event.target.files)
                    void receiver.useFiles(event.target.files, "reference");
                  event.target.value = "";
                }}
              />
            </div>
            <label>
              Creative direction{" "}
              <span className={styles.optional}>Optional</span>
              <textarea
                aria-label="Transform creative direction"
                rows={5}
                maxLength={GENJUTSU_LIMITS.maxPromptChars}
                value={saved ? String(saved.prompt ?? "") : input.prompt}
                onChange={(event) => change({ prompt: event.target.value })}
                placeholder="Describe what changes, what stays consistent, and the treatment you want."
              />
            </label>
            <div>
              <p className={styles.hint}>
                Creative directions · written by Particl
              </p>
              <div className={styles.chips}>
                {SUBATOMIK_DIRECTIONS.map(([name, prompt]) => (
                  <button
                    key={name}
                    type="button"
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
                aria-label="Transform output quality"
                value={saved ? String(saved.resolution) : input.resolution}
                onChange={(event) =>
                  change({
                    resolution: event.target.value as GenjutsuResolution,
                  })
                }
              >
                {GENJUTSU_RESOLUTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
          {receiver.busy && (
            <p role="status">Verifying or uploading the selected original…</p>
          )}
          {(error || paid.error) && (
            <p className={styles.error} role="alert">
              {error || paid.error}
            </p>
          )}
          {notice && (
            <p className={styles.notice} role="status">
              {notice}
            </p>
          )}
          {paid.pending ? (
            <div className={styles.quote}>
              <strong>Saved generation needs confirmation</strong>
              <p>
                The original{" "}
                {savedVariant ? GENJUTSU_LABELS[savedVariant] : "generation"}{" "}
                request is locked. Recover it before starting another.
              </p>
              {!!paid.pending.context?.price && (
                <span>
                  Approved price: {String(paid.pending.context.price)}
                </span>
              )}
              <button
                type="button"
                className="suite-primary"
                disabled={busy || !!paid.error || !recoverable}
                onClick={() => void submit()}
              >
                Recover saved transform request
              </button>
              {!recoverable && (
                <p role="alert">
                  This saved request does not match the selected project. Check
                  Activity in the original project.
                </p>
              )}
            </div>
          ) : quote ? (
            <div
              className={styles.quote}
              aria-label="Transform generation quote"
            >
              <strong>
                {price(quote)} · {GENJUTSU_LABELS[variant]}
              </strong>
              <p>
                {input.source?.name} · {input.resolution} ·{" "}
                {input.references.length} image references
              </p>
              <label className={styles.confirm}>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={blocked}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                Approve {price(quote)} for this generation.
              </label>
              <button
                type="button"
                className="suite-primary"
                disabled={blocked || !confirmed}
                onClick={() => void submit()}
              >
                {busy ? "Submitting once…" : `Generate · ${price(quote)}`}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="suite-primary"
              disabled={blocked || !input.source}
              onClick={() => void review()}
            >
              {busy ? "Checking source and price…" : "Review transform cost"}
              <ArrowUpRight size={15} />
            </button>
          )}
          <p className={styles.hint}>
            Your source original is retained. Review the transformed result for
            identity, product accuracy and continuity before delivery.
          </p>
        </section>
        <aside
          ref={library}
          className={`suite-panel ${styles.library}`}
          aria-label="Subatomik workspace assets"
        >
          <div className="suite-section-heading">
            <div>
              <h2>Workspace assets</h2>
              <p>
                Choose or drag a video as the source. Images become references.
              </p>
            </div>
          </div>
          <label className={styles.search}>
            Search assets
            <input
              aria-label="Search Subatomik assets"
              value={search}
              maxLength={200}
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
              change({
                prompt: take.prompt.slice(0, GENJUTSU_LIMITS.maxPromptChars),
              })
            }
            onEdit={(asset) => libraryTool(asset, "edit")}
            onUpscale={(asset) => libraryTool(asset, "upscale")}
          />
        </aside>
      </div>
      <section
        className={`suite-panel ${styles.results}`}
        aria-label="Subatomik project results"
      >
        <div className="suite-section-heading">
          <div>
            <h2>Project results</h2>
            <p>
              Transform takes from the latest 500 project generations. Originals
              remain in the shared library.
            </p>
          </div>
          <button
            type="button"
            className="suite-button"
            disabled={busy}
            onClick={() => void refreshResults()}
          >
            <RefreshCw size={14} />
            Refresh results
          </button>
        </div>
        {history.error ? (
          <p role="alert" className={styles.error}>
            {history.error}
          </p>
        ) : !history.data ? (
          <p role="status">Loading project results…</p>
        ) : !takes.length ? (
          <p className={styles.hint}>
            Your first transform result will appear here after you approve a
            generation.
          </p>
        ) : (
          <>
            <div className={styles.takeList}>
              {takes.map((take) => (
                <button
                  type="button"
                  key={take.id}
                  aria-pressed={selected?.id === take.id}
                  onClick={() => setSelectedId(take.id)}
                >
                  <strong>
                    {take.title ||
                      GENJUTSU_LABELS[genjutsuVariantForModel(take.model)!]}
                  </strong>
                  <span>
                    {take.status === "succeeded"
                      ? take.storedUrl
                        ? "Original ready"
                        : "Original unavailable"
                      : take.status}{" "}
                    · {money.take(take)}
                  </span>
                </button>
              ))}
            </div>
            {selected && (
              <>
                <SyncedVideoComparison
                  key={`${selected.id}:${readyOutput}`}
                  before={before}
                  after={
                    readyOutput
                      ? `/api/media/${encodeURIComponent(selected.id)}?stream=1`
                      : null
                  }
                  afterLabel={
                    GENJUTSU_LABELS[genjutsuVariantForModel(selected.model)!]
                  }
                  unavailable={
                    selected.error ||
                    (selected.status === "succeeded"
                      ? "The generated original is no longer available."
                      : "The original will appear when processing and storage finish.")
                  }
                />
                <div className={styles.actions}>
                  <button
                    type="button"
                    className="suite-button"
                    disabled={blocked || !!recreationUnavailable}
                    onClick={() => void restoreTake(selected.id)}
                  >
                    Recreate
                  </button>
                  <span className={styles.hint}>
                    {recreationUnavailable ||
                      "Restore this take’s recorded settings and references. A new generation always needs a fresh quote."}
                  </span>
                </div>
                {selected.status === "queued" && (
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className="suite-button"
                      disabled={busy || cancelRequested.includes(selected.id)}
                      onClick={() => void requestCancellation(selected)}
                    >
                      {cancelRequested.includes(selected.id)
                        ? "Cancellation requested · awaiting confirmation"
                        : "Request cancellation"}
                    </button>
                  </div>
                )}
                {readyOutput && (
                  <div className={styles.actions}>
                    <a
                      className="suite-button"
                      href={`/api/media/${encodeURIComponent(selected.id)}?download=1`}
                      download
                    >
                      Download original
                    </a>
                    <button
                      className="suite-primary"
                      type="button"
                      disabled={busy || !!paid.pending}
                      onClick={() => openInEdit(selected)}
                    >
                      Use in Edit <ArrowUpRight size={14} />
                    </button>
                    <Link
                      className="suite-button"
                      href={`/takes/${encodeURIComponent(selected.id)}`}
                    >
                      View take details
                    </Link>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </section>
      <SuiteAgentPanel
        suite="subatomik"
        project={project}
        scope={scope}
        enabled={!busy && !paid.pending}
        onApply={applyPlan}
      />
      {previewImage && (
        <ReferenceImagePreview
          asset={previewImage}
          onClose={() => setPreviewImage(null)}
        />
      )}
    </>
  );
}
