"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { useReferenceInbox } from "@/lib/shell/reference-inbox";
import { useShell } from "@/lib/shell/state";
import { useBodyQuote, quotePrice } from "@/lib/shell/use-quote";
import { ASTRA_MODEL, DEFAULT_ASTRA } from "@/lib/astra";
import { DEFAULT_TOPAZ_IMAGE } from "@/lib/topaz";
import { FRAME_RATES, IMAGE_SCALES, imageUpscaleBody, upscaleModel, upscaleSources, upscaleSurface, videoUpscaleBody, type UpscaleSource } from "@/lib/shell/upscale";
import { priceLabel, type SpendPrice } from "@/lib/spend";
import { usePaidAction } from "@/lib/usePaidAction";
import { refreshProjectLibrary, uploadFilesToProject, type LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import type { Project } from "@/lib/workbench/studio";
import { Glyph } from "../icons";
import { Price } from "../Price";
import { SpendButton } from "../SpendButton";
import { exact, upTo } from "@/lib/shell/price-words";

export const UPSCALE_NAME = "Upscale";
const CHOOSE = "Choose a picture or a clip.";

/**
 * Make › Upscale (design/particl-graphite, Make frames: the third quick tool beside Motion transfer and Object swap; `make=upscale`).
 * One source from this project's Library, a clip (Topaz Astra 2, to 4K at 30 or 60 fps) or a still (Topaz image upscale, 2× or
 * 4×), and Upscale at the server's quote for exactly that request: the button is off until the quote is in, and says "up to N cr"
 * when the charge settles on what is delivered. The quote and the one send are the existing routes through the existing paid
 * action (the same claim components/make/AstraUpscale.tsx and TopazImageUpscale.tsx keep, so either recovers a lost reply, and a
 * request is never sent twice). The original is kept; the result is a new take in this project's Library.
 */
export function UpscaleTool({ scope, project, items }: { scope: string; project: Project | null; items: readonly LibraryEntry[] }) {
  const shell = useShell();
  const { toast } = useWorkspace();
  const [added, setAdded] = useState<UpscaleSource[]>([]);
  const sources = useMemo(() => [...added, ...upscaleSources(items).filter((s) => !added.some((a) => a.id === s.id))], [added, items]);
  const [pick, setPick] = useState<string | null>(null);
  const source = sources.find((s) => s.id === pick) ?? null;
  const [fps, setFps] = useState<(typeof FRAME_RATES)[number]>(30);
  const [scale, setScale] = useState<(typeof IMAGE_SCALES)[number]>(2);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const production = project?.productionProjectId ?? null;
  const body = useMemo(() => {
    if (!source || !production) return null;
    return source.kind === "video"
      ? videoUpscaleBody(source, production, { ...DEFAULT_ASTRA, fps })
      : imageUpscaleBody(source, production, { ...DEFAULT_TOPAZ_IMAGE, factor: scale });
  }, [source, production, fps, scale]);
  const quote = useBodyQuote(scope, body);
  const ready = quote.state === "ready" ? quote : null;

  /* A request saved before a reply was lost is recovered, never sent twice: either panel's claim, for this project. */
  const videoPaid = usePaidAction(upscaleSurface("video", project?.id ?? null));
  const imagePaid = usePaidAction(upscaleSurface("image", project?.id ?? null));
  const paid = source?.kind === "image" ? imagePaid : videoPaid;
  const pending = paid.pending ?? videoPaid.pending ?? imagePaid.pending;
  const pendingPaid = paid.pending ? paid : videoPaid.pending ? videoPaid : imagePaid.pending ? imagePaid : null;

  /* The Library's `+` and a right-click's Use as reference land here while the tool is open. */
  const letter = useCallback((sent: { id: string }) => {
    const found = sources.find((s) => s.id === sent.id);
    if (found) { setPick(found.id); setNote(null); setProblem(null); } else setNote("That asset cannot be upscaled: it is not a finished picture or clip in this project.");
  }, [sources]);
  useReferenceInbox(letter);

  const upload = async (files: File[]) => {
    if (!files.length || !project) return;
    setNote(`Uploading ${files.length === 1 ? files[0].name : `${files.length} files`}…`);
    try {
      const { uploads, notes } = await uploadFilesToProject(scope, project.id, files);
      const first = uploads.find((u) => u.kind === "video" || u.kind === "image");
      if (first) {
        const made: UpscaleSource = { id: `upload:${first.id}`, sourceId: first.id, origin: "upload", kind: first.kind as "video" | "image", name: first.filename, url: first.url };
        setAdded((all) => [made, ...all.filter((a) => a.id !== made.id)]);
        setPick(made.id);
      }
      setNote(notes.join(" ") || (first ? null : "Only a picture or a clip can be upscaled."));
    } catch (e) { setNote(e instanceof Error ? e.message : "The file could not be uploaded."); }
  };

  const recovering = Boolean(pending);
  const saved = pending ? (JSON.parse(pending.body) as Record<string, unknown>) : null;
  const price: SpendPrice = recovering ? (typeof saved?.maxCredits === "number" ? { upTo: saved.maxCredits } : null) : quotePrice(ready?.quote);
  const reason = recovering ? null : !project ? "Open a project first." : !production ? "Saving this project…" : !source ? CHOOSE : quote.state === "error" ? quote.reason : !ready ? "Reading the price…" : null;
  const waits = busy || (!recovering && !ready);
  /* An unsettled request is what is shown, as it was saved: its kind and its setting, not the tool's defaults after a reload. */
  const savedKind = saved ? (saved.model === ASTRA_MODEL ? "video" : "image") : null;
  const kind = source?.kind ?? savedKind ?? "video";
  const shownFps = savedKind === "video" ? ((saved?.astra as { fps?: number } | undefined)?.fps === 60 ? 60 : 30) : fps;
  const shownScale = savedKind === "image" ? ((saved?.topaz as { factor?: number } | undefined)?.factor === 4 ? 4 : 2) : scale;
  const figure = price && typeof price === "object" ? (typeof price.upTo === "number" ? upTo(price.upTo) : typeof price.cr === "number" ? exact(price.cr) : null) : null;

  const press = async () => {
    if (waits || !project) return;
    setBusy(true); setProblem(null);
    try {
      const request = saved ?? { ...ready!.body, maxCredits: ready!.quote.estimatedCredits, quoteFingerprint: ready!.quote.fingerprint };
      const via = pendingPaid ?? paid;
      const result = await via.run<{ id: string }>("/api/generate", request, { context: { sourceName: source?.name, sourceUrl: source?.url, price: priceLabel(price) ?? undefined } });
      if (!result.data.id) throw new Error("Check Activity for the saved upscale request.");
      void refreshProjectLibrary(scope, project.id);
      toast(`${UPSCALE_NAME} · ${source?.name ?? "take"} · ${priceLabel(price) ?? "queued"} · rendering`);
      setNote("Queued. The result lands in this project's Library, and its progress is in Jobs.");
    } catch (e) { setProblem(e instanceof Error ? e.message : "The upscale was not sent."); } finally { setBusy(false); }
  };
  const library = () => shell.openLibrary("assets");

  return (
    <section className="gx-gen-card gx-make-compose vr-tool up-tool" aria-label={UPSCALE_NAME} data-testid="upscale-tool" data-kind={source?.kind ?? ""}>
      <div className="vr-src" data-testid="upscale-source-card">
        <div className="vr-src-media">
          {source ? <LazyMedia url={source.url} kind={source.kind} alt="" name={source.name} className="gx-lazy" preview={false} /> : null}
          <span className="gx-badge vr-src-badge">{source ? `SOURCE · ${source.kind === "video" ? "CLIP" : "PICTURE"}` : "SOURCE"}</span>
          {source ? <button type="button" className="gx-ref-x vr-src-x" aria-label={`Remove ${source.name}`} onClick={() => setPick(null)}>×</button> : null}
        </div>
        <div className="vr-src-foot">
          <div className="vr-src-text">
            <span className="vr-src-name" data-testid="upscale-source">{source ? source.name : "Choose a source"}</span>
            <span className="vr-src-line">A finished picture or clip from this project</span>
          </div>
          <button type="button" className="gx-hbtn" onClick={library} data-testid="upscale-library">Library</button>
        </div>
      </div>

      <div className="up-row">
        <label className="up-field"><span className="gx-eyebrow" data-functional-label="">Source</span>
          <select className="gx-select up-select" aria-label="Source" value={pick ?? ""} onChange={(e) => { setPick(e.target.value || null); setProblem(null); }} disabled={recovering} data-testid="upscale-select">
            <option value="">Choose from your takes…</option>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.kind === "video" ? "Clip" : "Picture"} · {s.name}</option>)}
          </select>
        </label>
        <button type="button" className="gx-hbtn" disabled={!project} onClick={() => file.current?.click()} data-testid="upscale-upload">Upload</button>
        <input ref={file} type="file" hidden accept="video/mp4,video/quicktime,image/png,image/jpeg,image/webp,.mp4,.mov" aria-label="Upload a source" onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      </div>

      <div className="up-row" data-testid="upscale-target">
        <div className="up-field"><span className="gx-eyebrow" data-functional-label="">Target</span>
          {kind === "video" ? (
            <div className="gx-seg gx-seg--sm" role="radiogroup" aria-label="Frame rate">
              {FRAME_RATES.map((r) => <button key={r} type="button" role="radio" className="gx-seg-btn" aria-checked={shownFps === r} disabled={recovering} onClick={() => setFps(r)}><span>4K · {r} fps</span></button>)}
            </div>
          ) : (
            <div className="gx-seg gx-seg--sm" role="radiogroup" aria-label="Scale">
              {IMAGE_SCALES.map((r) => <button key={r} type="button" role="radio" className="gx-seg-btn" aria-checked={shownScale === r} disabled={recovering} onClick={() => setScale(r)}><span>{r}× larger</span></button>)}
            </div>
          )}
        </div>
        <div className="up-field"><span className="gx-eyebrow" data-functional-label="">Model</span><span className="up-model" data-testid="upscale-model">{upscaleModel(kind)}</span></div>
      </div>

      <div className="gx-make-engine vr-engine" data-testid="upscale-engine">
        <Glyph name="upscale" size={16} className="gx-glyph" />
        <span className="gx-make-engine-line">
          <span className="gx-model-name">{upscaleModel(kind)}</span>
          <span className="gx-make-engine-part">{kind === "video" ? `4K · ${shownFps} fps` : `${shownScale}×`}</span>
          {figure ? <span className="gx-make-engine-part gx-mono" data-testid="upscale-price"><Price value={figure} /></span> : null}
        </span>
      </div>

      {recovering ? <p className="gx-gen-note" role="status" data-testid="upscale-recover">An upscale you sent was not confirmed. Recover it: the same request is checked, and it is never sent twice.</p> : null}
      {reason ? (
        <div className="vr-reason-row">
          <p className="gx-reason" id="up-reason" data-testid="upscale-reason">{reason}</p>
          {quote.state === "error" ? <span className="gx-hint">Change the source or Try again by choosing it again.</span> : null}
        </div>
      ) : null}
      {problem || paid.error ? <p className="gx-gen-error" role="alert" data-testid="upscale-problem">{problem ?? paid.error}</p> : null}
      {note ? <p className="gx-gen-note" role="status" data-testid="upscale-note">{note}</p> : null}
      <div className="gx-gen-cta gx-make-go">
        <span className="gx-make-dest">{project ? `To ${project.name} · Library` : null}</span>
        <SpendButton className="gx-primary gx-gen-go" label={recovering ? "Recover upscale" : UPSCALE_NAME} price={price} busy={busy} busyLabel="Sending…" disabled={waits}
          aria-describedby={reason ? "up-reason" : undefined} onClick={() => void press()} data-testid="upscale-go" />
      </div>
      <p className="gx-gen-foot" data-testid="upscale-foot">The original is kept · the result is a new take</p>
    </section>
  );
}
