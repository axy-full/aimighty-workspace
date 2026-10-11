import type { TenantToken, TenantUser } from "./tenant";
import type { GenerationRequest } from "./generationRequests";
import type { RunSpend } from "./runLimit";

/** These types have no runtime dependencies; pipeline snapshots stay server-side. */
export type AdmissionActor = { user: TenantUser; token?: TenantToken };
export type AdmissionReply = {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
};
export type AdmissionQuote = {
  fingerprint: string;
  estimatedCredits: number;
  price: number;
  unit: "cr" | "usd";
  /** Present when the figure is an approximation and the take settles on its delivered output. */
  approximate?: true;
  /**
   * Present when the take holds its ceiling (Cinema Studio, lib/cinemaHold.ts): what a person approves and
   * admission holds, "at most" this many credits. The approval (`maxCredits`) is this figure, not the estimate.
   */
  ceilingCredits?: number;
};
export type PreparedAdmission = {
  version: 1;
  kind: "image" | "video" | "audio";
  workspaceId: string;
  actorId: string;
  request: Record<string, unknown>;
  /** Server-only resolved prompt, references, settings and model used for approval. */
  compiled: Record<string, unknown>;
  quote: AdmissionQuote;
};
export type PrepareAdmissionResult =
  | { ok: true; value: PreparedAdmission }
  | { ok: false; status: number; body: Record<string, unknown> };
export type AdmissionCheckpoint = {
  kind: PreparedAdmission["kind"];
  request: Record<string, unknown>;
  compiled: Record<string, unknown>;
  quote: AdmissionQuote;
};
export type AdmissionExecution = {
  requestClaim?: GenerationRequest;
  defer: (work: () => Promise<unknown>) => void | Promise<void>;
  /** Internal server-only checkpoint; never supplied from an HTTP request. */
  checkpoint?: (value: AdmissionCheckpoint) => AdmissionReply | undefined;
  /**
   * Internal server-only, never from an HTTP request: the Atomik run this job counts toward.
   * Its reservation checks the run's approved limit (lib/runLimit.ts), and a take that would be
   * held (no credits, or no free slot) is refused instead: a held take could later start by
   * itself, outside the run's limit.
   */
  run?: RunSpend;
};
export type AdmissionExecutor = (
  input: Record<string, unknown>,
  actor: AdmissionActor,
  options: AdmissionExecution,
) => Promise<AdmissionReply>;
