import type { TenantToken, TenantUser } from "./tenant";
import type { GenerationRequest } from "./generationRequests";

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
  defer: (work: () => Promise<unknown>) => void;
  /** Internal server-only checkpoint; never supplied from an HTTP request. */
  checkpoint?: (value: AdmissionCheckpoint) => AdmissionReply | undefined;
};
export type AdmissionExecutor = (
  input: Record<string, unknown>,
  actor: AdmissionActor,
  options: AdmissionExecution,
) => Promise<AdmissionReply>;
