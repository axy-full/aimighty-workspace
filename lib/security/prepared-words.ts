/**
 * A prepared job as the routes return it and Settings › Connections shows it (lib/security/prepared-jobs.ts). Pure.
 */
export type PreparedState = "waiting" | "opened" | "dismissed";
export type PreparedJob = {
  id: string; tokenId: string; tokenName: string | null; prompt: string;
  model: "2.5" | "2.0"; duration: number; resolution: string; ratio: string; audio: boolean; project: string | null;
  state: PreparedState; createdAt: number; decidedAt: number | null;
};

/** The Seedance model id Make opens with: the same mapping render_shot uses (lib/mcp.ts). */
export const preparedModelId = (model: "2.5" | "2.0") => (model === "2.0" ? "dreamina-seedance-2-0-260128" : "dreamina-seedance-2-5-260628");

/** "Seedance 2.5 · 5 s · 1080p · 16:9", what a person reads before opening it. No price: Make shows that. */
export const preparedSpec = (job: Pick<PreparedJob, "model" | "duration" | "resolution" | "ratio" | "audio">) =>
  [`Seedance ${job.model}`, `${job.duration} s`, job.resolution, job.ratio, job.audio ? "with sound" : null].filter(Boolean).join(" · ");
