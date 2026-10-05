"use client";
import { useEffect, useMemo, useState } from "react";
import { Price } from "@/components/graphite/Price";
import { exact } from "@/lib/shell/price-words";
import { estimateReason } from "@/lib/shell/key-estimate";
import { useKeyTake } from "@/lib/shell/use-key-take";
import { sendReference } from "@/lib/shell/reference-inbox";
import {
  IMAGE_AD_ASPECTS, IMAGE_AD_PROMPT_MAX, IMAGE_AD_RESOLUTIONS, INITIAL_IMAGE_AD, imageAdBlock, imageAdBuild, imageAdRequest, withProductStill, type ImageAdState,
} from "@/lib/shell/image-ads";
import { generationRequestBody } from "@/lib/workbench/generation-request";
import { usePlanRequest } from "@/lib/workspace/atomik-host";
import { reviewProjectTake } from "@/lib/workspace/library";
import { useBoard } from "../../BoardContext";
import type { CardProps } from "../../cards/types";
import type { ImageAdData, ResultData, UnavailableData } from "../ads-model";
import { openDesigner } from "../ads-session";
import { posterFor } from "../designer-model";
import { Actions, Btn, Meta, Note, Title, Well } from "./common";
import { uid } from "@/lib/workbench/studio";

/* Frame 2 of the Ads board: the group "Ads": the image-ad card (Marketing Studio Image 2.0 Alpha), results, and what is not built. */

const ENGINE = `Marketing Studio Image · ${imageAdBuild("alpha").label}`;
const SIZE_WORDS: Record<string, string> = { "1k": "1K", "2k": "2K", "4k": "4K" };

/** One branded still from the product image, on Particl's Higgsfield API key: the estimate on the button, then one send at that figure. */
export function ImageAdCard({ data }: CardProps<ImageAdData>) {
  const { scope, project, rig } = useBoard();
  const [aspect, setAspect] = useState("1:1");
  const [resolution, setResolution] = useState("2k");
  const [open, setOpen] = useState(false);
  const [edited, setEdited] = useState<string | null>(null);
  const prompt = edited ?? data.defaultPrompt;
  const take = useKeyTake(scope, project.id, "ads:image-ad");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);

  const state: ImageAdState = useMemo(() => withProductStill({ ...INITIAL_IMAGE_AD, build: "alpha", prompt, aspect, resolution, quality: "high" }, data.still), [prompt, aspect, resolution, data.still]);
  const blocked = !data.still ? "Add the product's image first: Edit on Product facts." : imageAdBlock(state, { hasProject: true, saved: Boolean(data.productionId) });
  const request = useMemo(() => (!blocked && data.productionId ? imageAdRequest(state, { productionProjectId: data.productionId }) : null), [blocked, data.productionId, state]);
  const key = JSON.stringify(request);
  /* Atomik's plan sends this very body through the same gate (lib/workspace/plans.ts › variants). */
  const planBodies = useMemo(() => (request?.endpoint === "/api/generate" && request.input ? [{ name: "Image ad", body: generationRequestBody(request.input) }] : undefined), [request]);
  usePlanRequest("variants", planBodies as never);

  const quote = take.quote, estimateKey = take.estimate?.key, expires = take.estimate?.expiresAt ?? 0, phase = take.run.phase;
  const busy = phase === "submitting" || phase === "running";
  useEffect(() => {
    if (!request || busy) return;
    if (estimateKey === key && expires > now) return;
    const timer = setTimeout(() => void quote(request, key), 700);
    return () => clearTimeout(timer);
  }, [request, key, quote, estimateKey, expires, now, busy]);
  const reason = blocked ?? estimateReason(take.estimate, key, now);
  const credits = !reason && take.estimate?.key === key ? take.estimate.credits : null;
  const price = exact(credits);
  const failedEstimate = Boolean(!blocked && take.estimate?.key === key && take.estimate.error);
  const run = take.run;
  const running = run.phase === "running" ? run : null;

  return (
    <article className="bd-card ab-card" data-testid="ads-image-ad">
      <Well url={data.stillUrl} media="image" tag="IMAGE AD" height={128} empty="The product's image goes here" />
      <span className="ab-body ab-body--fill">
        <Title>{data.productName ? `${data.productName} · image ad` : "Image ad"}</Title>
        <span className="ab-engine" data-testid="ads-image-ad-engine">
          <span>{ENGINE} · {aspect} · {SIZE_WORDS[resolution] ?? resolution}{price ? <> · <Price value={price} /></> : null}</span>
          <button type="button" className="ab-link nodrag nopan" aria-expanded={open} onClick={() => setOpen(!open)}>Change</button>
        </span>
        {open ? (
          <span className="ab-change nodrag nopan">
            <span className="ab-chips" role="group" aria-label="Aspect">{IMAGE_AD_ASPECTS.map((a) => <button key={a} type="button" className="ab-chip" aria-pressed={aspect === a} onClick={() => setAspect(a)}>{a}</button>)}</span>
            <span className="ab-chips" role="group" aria-label="Size">{IMAGE_AD_RESOLUTIONS.map((r) => <button key={r} type="button" className="ab-chip" aria-pressed={resolution === r} onClick={() => setResolution(r)}>{SIZE_WORDS[r] ?? r}</button>)}</span>
          </span>
        ) : null}
        <textarea className="ab-prompt nodrag nopan nowheel" aria-label="Prompt" rows={5} maxLength={IMAGE_AD_PROMPT_MAX} value={prompt} onChange={(e) => setEdited(e.target.value)} data-testid="ads-image-ad-prompt" />
        {reason && !failedEstimate ? <Note role="status">{reason}</Note> : null}
        {failedEstimate && request ? <Note tone="bad" role="alert">{reason} <button type="button" className="ab-link nodrag nopan" onClick={() => void take.quote(request, key)}>Try again</button></Note> : null}
        {run.phase === "failed" ? <Note tone="bad" role="alert">{run.error}</Note> : null}
        {take.note ? <Note role="status">{take.note}</Note> : null}
        {running ? <Note role="status">{running.held ? "Held · it starts when credits arrive" : running.generation?.status === "queued" ? "Queued" : "Rendering"} · <Price value={exact(running.credits)} /></Note> : null}
        {run.phase === "done" ? <Note role="status">Done · it is in Ads below.</Note> : null}
        <Actions>
          <Btn primary disabled={Boolean(reason) || busy || rig.status !== "ready"} onClick={() => { if (request) void take.submit(request, key, credits); }} data-testid="ads-image-ad-make">
            {phase === "submitting" ? "Submitting…" : running ? "Rendering…" : <>Make the image ad{price ? <> · <Price value={price} /></> : null}</>}
          </Btn>
        </Actions>
      </span>
    </article>
  );
}

const REVIEW_WORDS: Record<string, string> = { approved: "Approved", changes: "Rejected", picked: "Picked" };

export function ResultCard({ data }: CardProps<ResultData>) {
  const { scope, project, toast, rig, openMake } = useBoard();
  const [busy, setBusy] = useState(false);
  const inFlight = data.status === "rendering" || data.status === "held";
  const judge = async (state: "approved" | "changes") => {
    setBusy(true);
    try { await reviewProjectTake(scope, project.id, data.sourceId, state); toast(state === "approved" ? "Approved" : "Rejected · nothing more is spent"); }
    catch (cause) { toast(cause instanceof Error ? cause.message : "The review was not saved."); }
    finally { setBusy(false); }
  };
  const openDesigner_ = () => {
    rig.apply((current) => posterFor(current, uid, data.asset).project);
    void rig.save();
    openDesigner(project.id, true);
  };
  return (
    <article className="bd-card ab-card" data-testid="ads-result" data-review={data.review || undefined}>
      <Well url={data.failure || inFlight ? null : data.url} media={data.media} tag={`${data.tag}${data.review ? ` · ${REVIEW_WORDS[data.review]?.toUpperCase() ?? ""}` : ""}`} height={173}
        empty={inFlight ? (data.status === "held" ? "Held for credits" : "Rendering…") : data.failure ? "Failed" : undefined} />
      <span className="ab-body">
        <Title>{data.name}</Title>
        <Meta>{data.engine}{data.credits != null ? <> · <Price value={exact(data.credits)} /> paid</> : null}</Meta>
        {data.failure ? <Note tone="bad" role="alert">{data.failure}</Note> : null}
        {!data.failure && !inFlight ? (
          <Actions>
            <Btn primary={data.review === ""} aria-pressed={data.review === "approved"} disabled={busy} onClick={() => void judge("approved")}>Approve</Btn>
            <Btn aria-pressed={data.review === "changes"} disabled={busy} onClick={() => void judge("changes")}>Reject</Btn>
            <Btn onClick={() => { sendReference({ id: data.id, name: data.name }); openMake(data.media === "video" ? "video" : "image"); }}>Use as reference</Btn>
            {data.media === "image" ? <Btn onClick={openDesigner_} data-testid="ads-open-designer">Open the Designer</Btn> : null}
          </Actions>
        ) : null}
      </span>
    </article>
  );
}

export function UnavailableCard({ data }: CardProps<UnavailableData>) {
  return (
    <article className="bd-card ab-card ab-card--off" data-testid="ads-unavailable">
      <span className="ab-body">
        <Title>{data.title}</Title>
        <Meta>{data.line}</Meta>
      </span>
    </article>
  );
}
