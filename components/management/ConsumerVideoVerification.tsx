"use client";

import { useEffect, useRef, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { useSession } from "@/lib/session";

type Job = {
  id: string; draftId: string; status: string; workspaceId: string; workspaceName: string;
  quoteCredits: number; quoteExpiresAt: number; providerJobId: string | null;
  providerReceipt?: unknown; result?: unknown;
  originalAvailable?: boolean; originalAvailability?: "available" | "deleted" | "unavailable" | "not_collected";
};
function savedOriginal(job: Job | null) {
  if (job?.status !== "completed" || job.originalAvailable !== true || job.originalAvailability !== "available" || !job.result || typeof job.result !== "object") return null;
  const original = (job.result as { original?: unknown }).original;
  if (!original || typeof original !== "object") return null;
  const value = original as Record<string, unknown>, asset = value.asset;
  if (!asset || typeof asset !== "object" || typeof value.generationId !== "string" ||
    typeof job.providerJobId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.providerJobId) ||
    !/^gen_hfc_[a-f0-9]{40}$/.test(value.generationId) || value.providerJobId !== job.providerJobId ||
    typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    value.creditUnit !== "higgsfield_credits" || value.credits !== job.quoteCredits ||
    ![value.width, value.height, value.seconds].every(number => typeof number === "number" && Number.isFinite(number) && number > 0) ||
    typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes <= 0) return null;
  const media = asset as Record<string, unknown>, url = `/api/media/${value.generationId}`;
  if (media.url !== url || media.generationId !== value.generationId || media.kind !== "video" || media.mime !== "video/mp4") return null;
  return { url, bytes: value.bytes, sha256: value.sha256 };
}

/** Owner-operated verification. Opening settings or obtaining a quote never
 * submits a job; paid admission is only the explicitly priced button below. */
export default function ConsumerVideoVerification() {
  const { requestScope } = useSession();
  const request = useScopedFetch();
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [providerStatus, setProviderStatus] = useState<unknown>(null);
  const [nextPollAt, setNextPollAt] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const [walletReviewed, setWalletReviewed] = useState(false);
  const pending = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    void request("/api/higgsfield/consumer/video").then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load verification jobs.");
      if (current) setJob(result.jobs?.[0] ?? null);
    }).catch(reason => { if (current) setError(reason instanceof Error ? reason.message : "Could not load verification jobs."); });
    return () => { current = false; };
  }, [request, requestScope]);
  useEffect(() => {
    if (!job) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job]);
  async function act(action: "quote-rehearsal" | "submit" | "status") {
    if (pending.current) return;
    if (action === "submit" && (!job || !walletReviewed || job.quoteExpiresAt <= Date.now())) return;
    if (action === "status" && (!job || Date.now() < nextPollAt)) return;
    pending.current = true; setBusy(action); setError("");
    try {
      const body = action === "quote-rehearsal" ? { action, idempotencyKey: crypto.randomUUID() }
        : { action, id: job!.id, draftId: job!.draftId,
          ...(action === "submit" ? { workspaceId: job!.workspaceId, credits: job!.quoteCredits } : {}) };
      const response = await request("/api/higgsfield/consumer/video", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The verification request could not be completed.");
      if (!active.current) return;
      if (!result.job?.id || typeof result.job.status !== "string") throw new Error("The saved verification job is unavailable. Refresh before continuing.");
      setJob(result.job); setClock(Date.now());
      if (action === "quote-rehearsal") { setWalletReviewed(false); setProviderStatus(null); }
      if (action === "status") setProviderStatus(result.providerStatus ?? null);
      if (result.pollAfterSeconds) setNextPollAt(Date.now() + Math.max(15, result.pollAfterSeconds) * 1000);
    } catch (reason) { if (active.current) setError(reason instanceof Error ? reason.message : "The request could not be completed."); }
    finally { pending.current = false; if (active.current) setBusy(""); }
  }
  const underway = job && ["dispatching", "accepted", "uncertain"].includes(job.status);
  const original = savedOriginal(job);
  return <section className="rounded-xl border border-line p-4 space-y-3" aria-label="Marketing Video verification">
    <div><h3 className="text-sm font-medium">Verify Marketing Video</h3>
      <p className="mt-1 text-xs text-mute leading-relaxed">One 15-second, 720p product demonstration with generated audio: a plain reusable bottle, without people, logos or text. Saved in a separate Higgsfield qualification project.</p></div>
    {!underway && <button type="button" className="management-button" disabled={!!busy} onClick={() => void act("quote-rehearsal")}>{busy === "quote-rehearsal" ? "Reading exact price…" : "Get verification quote"}</button>}
    {job && <>
      <p role="status" className="text-sm">{job.status === "quoted" ? `${job.quoteCredits} Higgsfield credits · ${job.workspaceName}` : job.status === "accepted" ? "Higgsfield accepted the video request. Check the saved job for its result." : job.status === "uncertain" || job.status === "dispatching" ? "Submission needs reconciliation. This request will not be sent again." : `Verification: ${job.status}`}</p>
      {job.status === "quoted" && <>
        <p className="text-xs text-mute">{job.quoteExpiresAt > clock ? "This quote expires in five minutes. Higgsfield bills its active workspace, which is shared across its connected clients. Particl checks the wallet and price again before sending." : "This quote expired. Get a fresh quote before generating."}</p>
        <label className="flex items-start gap-2 text-xs leading-relaxed"><input type="checkbox" checked={walletReviewed} disabled={!!busy} onChange={event => setWalletReviewed(event.target.checked)} />Charge {job.quoteCredits} Higgsfield credits to {job.workspaceName} for this one test.</label>
        <button type="button" className="management-button primary" disabled={!!busy || !walletReviewed || job.quoteExpiresAt <= clock} onClick={() => void act("submit")}>{busy === "submit" ? "Submitting once…" : `Run verification · ${job.quoteCredits} credits`}</button>
      </>}
      {(job.status === "accepted" || job.status === "uncertain" && !!job.providerReceipt) && <button type="button" className="management-button" disabled={!!busy || clock < nextPollAt} onClick={() => void act("status")}>{busy === "status" ? "Reading saved job…" : clock < nextPollAt ? `Check again in ${Math.ceil((nextPollAt-clock)/1000)}s` : job.status === "uncertain" ? "Check saved submission" : "Check verification result"}</button>}
      {original && <div className="space-y-2"><video controls preload="metadata" src={original.url} className="max-h-80 w-full rounded-lg bg-black" aria-label="Verified Marketing Video original" /><p className="text-xs text-mute">Original retained · {(original.bytes / 1024 / 1024).toFixed(2)} MB · SHA-256 recorded</p><a className="management-button" href={`${original.url}?download=1`}>Download original video</a></div>}
      {job.status === "completed" && !original && <p className="text-xs text-mute">{job.originalAvailability === "deleted" ? "The original video was deleted from the library. Its job receipt is retained; preview and download are unavailable." : "The original video is unavailable. Its job receipt is retained; preview and download are unavailable."}</p>}
      {(providerStatus || job.providerReceipt || job.result) && <details><summary className="cursor-pointer text-xs text-mute">Verification result details</summary><pre aria-label="Higgsfield verification result" className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-chip p-3 text-[11px]">{JSON.stringify(providerStatus ?? job.result ?? job.providerReceipt, null, 2)}</pre></details>}
    </>}
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
  </section>;
}
