/**
 * A prepared job as the routes return it and Settings › Connections shows it (lib/security/prepared-jobs.ts). Pure.
 */
export type PreparedState = "waiting" | "opened" | "dismissed";
export type PreparedJob = {
  id: string; tokenId: string; tokenName: string | null; prompt: string;
  /** Set for a direct engine's job (not a Seedance render): the tool's id. Its words are `prompt`; it is not opened in Make. */
  engine: { tool: string } | null;
  model: "2.5" | "2.0"; duration: number; resolution: string; ratio: string; audio: boolean; project: string | null;
  state: PreparedState; createdAt: number; decidedAt: number | null;
};

/** The Seedance model id Make opens with: the same mapping render_shot uses (lib/mcp.ts). */
export const preparedModelId = (model: "2.5" | "2.0") => (model === "2.0" ? "dreamina-seedance-2-0-260128" : "dreamina-seedance-2-5-260628");

/** "Seedance 2.5 · 5 s · 1080p · 16:9", what a person reads before opening it. No price: Make shows that. */
export const preparedSpec = (job: Pick<PreparedJob, "model" | "duration" | "resolution" | "ratio" | "audio"> & { engine?: PreparedJob["engine"] }) =>
  job.engine ? job.engine.tool.replace(/_/g, " ") : [`Seedance ${job.model}`, `${job.duration} s`, job.resolution, job.ratio, job.audio ? "with sound" : null].filter(Boolean).join(" · ");
