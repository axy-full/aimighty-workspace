"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AudioLines,
  Download,
  Film,
  FolderPlus,
  Image as ImageIcon,
  RefreshCw,
  X,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useMoney } from "@/lib/price";
import { saveDraft } from "@/lib/draft";
import { shortLabel } from "@/lib/models";
import { timeAgo } from "@/lib/format";
import type { Generation } from "@/lib/jobs";
import type { ProductionRow } from "@/lib/productions";
import type { Shot } from "@/lib/shots";
import { useToast } from "@/components/ui/Toast";
import LazyMedia from "@/components/LazyMedia";
import styles from "./gen.module.css";

type Kind = "video" | "image" | "audio" | "all";
type Filing = {
  id: string;
  project: { id: string; name: string } | null;
};
type Props = {
  kind: Kind;
  search?: string;
  onTotals?: (totals: { takes: number; spent: string }) => void;
  columns?: string;
  phone?: boolean;
  onUsePrompt?: (take: Generation) => void;
  onEdit?: (take: Generation) => void;
  onAstraUpscale?: (take: Generation) => void;
  onUpscale?: (take: Generation) => void;
};

export default function UnfiledWall(props: Props) {
  const { workspace, email, signedIn } = useSession();
  return (
    <ScopedWall
      key={JSON.stringify([signedIn, workspace?.id, email, props.kind])}
      {...props}
    />
  );
}
function ScopedWall({
  kind,
  search = "",
  onTotals,
  onUsePrompt,
  onEdit,
  onAstraUpscale,
  onUpscale,
}: Props) {
  const { signedIn, workspace, email } = useSession(),
    money = useMoney(),
    toast = useToast(),
    router = useRouter();
  const q = search.trim() ? `&q=${encodeURIComponent(search.trim())}` : "";
  const { data, refresh, error } = useApi<{ generations: Generation[] }>(
    signedIn
      ? `/api/jobs?unfiled=1&limit=200&sync=0${kind === "all" ? "" : `&kind=${kind}`}${q}`
      : null,
    5000,
  );
  const { data: prods } = useApi<{ productions: ProductionRow[] }>(
    signedIn ? "/api/productions" : null,
    60000,
  );
  const gens = useMemo(() => data?.generations ?? [], [data]);
  const [filing, setFiling] = useState<Filing | null>(null),
    [busy, setBusy] = useState<string | null>(null),
    [selected, setSelected] = useState<string | null>(null);
  const takes = gens.length,
    spent = money.sum(gens);
  useEffect(() => {
    if (signedIn && data) onTotals?.({ takes, spent });
  }, [takes, spent, onTotals, signedIn, data]);
  const file = async (take: Generation, shot: Shot) => {
    setBusy(take.id);
    setFiling(null);
    try {
      const r = await fetch(`/api/jobs/${encodeURIComponent(take.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shotId: shot.id }),
      });
      if (!r.ok) throw Error("That take could not be filed. Try again.");
      toast(`Filed to ${shot.code}`);
      await refresh();
    } catch (error) {
      toast((error as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const reusePrompt = (take: Generation) => {
    if (onUsePrompt) {
      onUsePrompt(take);
      return;
    }
    // Loading an existing prompt is an edit; generation still requires its priced action.
    const scope = JSON.stringify([workspace?.id, email, take.kind]);
    saveDraft(`make:${scope}`, String(take.params.rawPrompt || take.prompt));
    router.push(
      `/generate?mode=${take.kind === "image" ? "images" : take.kind}`,
    );
  };
  const running = (g: Generation) =>
    ["running", "queued", "held"].includes(g.status);
  const openFile = (g: Generation) => setFiling({ id: g.id, project: null });
  const current = gens.find((g) => g.id === selected);
  const mediaUrl = (take: Generation) =>
    `/api/media/${encodeURIComponent(take.id)}?stream=1`;
  const description = (take: Generation) =>
    String(take.params.rawPrompt || take.title || take.prompt);
  const kindLabel = (take: Generation) =>
    take.kind === "image" ? "Image" : take.kind === "audio" ? "Audio" : "Video";
  if (error)
    return (
      <div className={styles.empty}>
        <h3>Takes could not be loaded</h3>
        <p>{error}</p>
        <button type="button" className={styles.secondary} onClick={refresh}>
          <RefreshCw size={16} />
          Try again
        </button>
      </div>
    );
  if (signedIn && !data)
    return (
      <div className={styles.empty} role="status">
        <span className={styles.loadingMark} />
        <p>Loading your takes…</p>
      </div>
    );
  if (!gens.length)
    return (
      <div className={styles.empty}>
        <div className={styles.emptyFrame}>
          {kind === "audio" ? (
            <AudioLines size={36} />
          ) : kind === "image" ? (
            <ImageIcon size={36} />
          ) : (
            <Film size={36} />
          )}
          <span>01</span>
        </div>
        <h3>{search ? "No matching takes" : "Your next take starts here."}</h3>
        <p>
          {search
            ? "Try another word from your prompt."
            : signedIn
              ? "Describe an idea and generate. Review, download or file the result to a shot."
              : "Explore the controls. Sign in when you’re ready to make your first take."}
        </p>
      </div>
    );
  return (
    <>
      <div className={styles.takeGrid} data-wall="">
        {gens.map((take) => {
          const active = running(take),
            finished =
              take.status === "succeeded" && (take.storedUrl || take.sourceUrl);
          return (
            <article
              key={take.id}
              className={styles.takeCard}
              aria-label={`${kindLabel(take)} take`}
            >
              <button
                type="button"
                className={styles.takeMedia}
                disabled={!finished}
                onClick={() => setSelected(take.id)}
                aria-label={`Preview ${take.title || kindLabel(take) + " take"}`}
              >
                {finished && take.kind !== "audio" ? (
                  <LazyMedia
                    url={mediaUrl(take)}
                    kind={take.kind}
                    className={styles.thumbnail}
                    hoverPlay={take.kind === "video"}
                  />
                ) : (
                  <span className={styles.mediaSymbol}>
                    {take.kind === "audio" ? (
                      <AudioLines size={32} />
                    ) : (
                      <Film size={28} />
                    )}
                  </span>
                )}
                <span className={styles.takeKind}>
                  {kindLabel(take)}
                  {take.params.duration ? ` · ${take.params.duration}s` : ""}
                </span>
                <span className={styles.takeCost}>{money.take(take)}</span>
                {active && (
                  <span className={styles.jobStatus}>
                    {take.status === "held"
                      ? "Needs attention"
                      : take.status === "queued"
                        ? "Queued"
                        : "Generating"}
                    <i />
                  </span>
                )}
                {take.status === "failed" && (
                  <span className={styles.jobStatus}>Failed</span>
                )}
              </button>
              <div className={styles.takeInfo}>
                <p>{description(take)}</p>
                <span>
                  {shortLabel(take.model)} · {timeAgo(take.createdAt)}
                </span>
                {take.error && <p className={styles.takeError}>{take.error}</p>}
              </div>
              <div className={styles.takeActions}>
                <button type="button" onClick={() => reusePrompt(take)}>
                  <RefreshCw size={14} />
                  Use prompt
                </button>
                {onAstraUpscale && take.kind === "video" && take.status === "succeeded" && (
                  <button type="button" onClick={() => onAstraUpscale(take)}>Upscale video</button>
                )}
                {onEdit &&
                  take.kind === "video" &&
                  take.status === "succeeded" && (
                    <button type="button" onClick={() => onEdit(take)}>
                      Edit clip
                    </button>
                  )}
                {onUpscale && take.kind === "image" && finished && <button type="button" onClick={() => onUpscale(take)}>Upscale image</button>}
                <button
                  type="button"
                  disabled={!finished || busy === take.id}
                  onClick={() => openFile(take)}
                >
                  <FolderPlus size={14} />
                  File to shot
                </button>
                {finished && (
                  <a
                    href={`/api/media/${encodeURIComponent(take.id)}?download=1`}
                    download
                    aria-label="Download take"
                  >
                    <Download size={15} />
                  </a>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <DialogPrimitive.Root
        open={!!current}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className={styles.dialogOverlay} />
          <DialogPrimitive.Content
            className={`${styles.dialog} ${styles.previewDialog}`}
            aria-describedby={undefined}
          >
            <div className={styles.dialogHeader}>
              <DialogPrimitive.Title>
                {current?.title || "Review take"}
              </DialogPrimitive.Title>
              <DialogPrimitive.Close aria-label="Close preview">
                <X size={19} />
              </DialogPrimitive.Close>
            </div>
            {current && (
              <>
                <div className={styles.preview}>
                  {current.kind === "image" ? (
                    <img src={mediaUrl(current)} alt={description(current)} />
                  ) : current.kind === "audio" ? (
                    <audio src={mediaUrl(current)} controls />
                  ) : (
                    <video src={mediaUrl(current)} controls playsInline />
                  )}
                </div>
                <p className={styles.previewPrompt}>{description(current)}</p>
                <a
                  className={styles.secondary}
                  href={`/api/media/${encodeURIComponent(current.id)}?download=1`}
                  download
                >
                  <Download size={16} />
                  Download take
                </a>
              </>
            )}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <DialogPrimitive.Root
        open={!!filing}
        onOpenChange={(open) => {
          if (!open) setFiling(null);
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className={styles.dialogOverlay} />
          <DialogPrimitive.Content
            className={styles.dialog}
            aria-describedby={undefined}
          >
            <div className={styles.dialogHeader}>
              <DialogPrimitive.Title>
                {filing?.project
                  ? `File to ${filing.project.name}`
                  : "File to a project"}
              </DialogPrimitive.Title>
              <DialogPrimitive.Close aria-label="Close filing">
                <X size={19} />
              </DialogPrimitive.Close>
            </div>
            {filing?.project ? (
              <>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() =>
                    setFiling((value) => value && { ...value, project: null })
                  }
                >
                  Choose another production
                </button>
                <FilingShots
                  key={filing.project.id}
                  projectId={filing.project.id}
                  onSelect={(shot) => {
                    const take = gens.find((g) => g.id === filing.id);
                    if (take) void file(take, shot);
                  }}
                />
              </>
            ) : (
              <div className={styles.modelList}>
                {(prods?.productions ?? []).flatMap((production) =>
                  production.projects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() =>
                        setFiling(
                          (value) =>
                            value && {
                              ...value,
                              project: { id: project.id, name: project.name },
                            },
                        )
                      }
                    >
                      <span>
                        <strong>{production.name}</strong>
                        <small>
                          {production.projects.length > 1
                            ? project.name
                            : "Main film"}
                        </small>
                      </span>
                      <span>{project.shots} shots</span>
                    </button>
                  )),
                )}
                {prods && !prods.productions.length && (
                  <p>No projects yet.</p>
                )}
              </div>
            )}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}

function FilingShots({
  projectId,
  onSelect,
}: {
  projectId: string;
  onSelect: (shot: Shot) => void;
}) {
  const { data, error, refresh } = useApi<{ shots: Shot[] }>(
    `/api/shots?projectId=${encodeURIComponent(projectId)}`,
    0,
  );
  if (error)
    return (
      <div role="alert">
        <p>{error}</p>
        <button type="button" className={styles.secondary} onClick={refresh}>
          Try again
        </button>
      </div>
    );
  if (!data) return <p role="status">Loading shots…</p>;
  return (
    <div className={styles.modelList}>
      {data.shots.map((shot) => (
        <button key={shot.id} type="button" onClick={() => onSelect(shot)}>
          <span>
            <strong>{shot.code}</strong>
            <small>{shot.description || shot.title || "Untitled shot"}</small>
          </span>
          <FolderPlus size={18} />
        </button>
      ))}
      {!data.shots.length && <p>No shots in this project yet.</p>}
    </div>
  );
}
