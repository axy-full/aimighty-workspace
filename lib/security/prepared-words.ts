/**
 * A prepared job as the routes return it and Settings › Connections shows it (lib/security/prepared-jobs.ts). Pure.
 */
export type PreparedState = "waiting" | "opened" | "dismissed" | "approved";
export type PreparedJob = {
  id: string; tokenId: string; tokenName: string | null; prompt: string;
  model: "2.5" | "2.0"; duration: number; resolution: string; ratio: string; audio: boolean; project: string | null;
  state: PreparedState; createdAt: number; decidedAt: number | null;
  /** The take a person's approval started (state "approved"); null until it has started. */
  takeId: string | null;
};

/** The Seedance model id Make opens with: the same mapping render_shot uses (lib/mcp.ts). */
export const preparedModelId = (model: "2.5" | "2.0") => (model === "2.0" ? "dreamina-seedance-2-0-260128" : "dreamina-seedance-2-5-260628");

/** "Seedance 2.5 · 5 s · 1080p · 16:9", what a person reads before opening it. No price: Make shows that. */
export const preparedSpec = (job: Pick<PreparedJob, "model" | "duration" | "resolution" | "ratio" | "audio">) =>
  [`Seedance ${job.model}`, `${job.duration} s`, job.resolution, job.ratio, job.audio ? "with sound" : null].filter(Boolean).join(" · ");

/**
 * What a person's "Approve at N cr" sends: the prepared job as Make's own request, through the one workspace-credit path (lib/workspace/generate-submit.ts).
 * The same body render_shot builds (lib/mcp.ts): Seedance, no references, filed to `projectId` or to none. The price is never in it: the server quotes it.
 */
export function preparedGenerationInput(job: Pick<PreparedJob, "prompt" | "model" | "duration" | "resolution" | "ratio" | "audio">, projectId: string | null) {
  return {
    prompt: job.prompt, kind: "video" as const, model: { id: preparedModelId(job.model) }, mapping: { productionProjectId: projectId ?? "" },
    ratio: job.ratio, resolution: job.resolution, duration: job.duration, references: [] as never[], generateAudio: job.audio,
  };
}

/** A claim an approval left without starting anything is let go after this long, so a closed tab never strands a job. */
export const APPROVAL_CLAIM_MS = 5 * 60_000;
