import type { ProviderId } from "../providers";
import type { ModelDef } from "../models";
import type { TaskDef } from "../tasks";
import type { VideoParams, Reference } from "../ark";

/**
 * One interface for every engine (brief 1.1): estimate, render, poll,
 * fetchMaster — and run, for the one adapter that thinks rather than
 * draws. A vendor is one file under lib/engines; the registry is the only
 * place that knows which files exist. Everything that spends money still
 * goes through the metering layer at the route, unchanged.
 */
export type EngineKind = "video" | "image" | "audio" | "text";

export type VideoRenderRequest = {
  kind: "video"; genId: string; model: ModelDef; task: TaskDef; prompt: string;
  params: VideoParams; references: Reference[]; source: Reference | null;
};
export type StillRenderRequest = {
  kind: "image"; genId: string; model: ModelDef; prompt: string; ratio: string; size: string; references: Reference[];
};
export type AudioRenderRequest = {
  kind: "audio"; genId: string; modelId: string; task: "speech" | "sound" | "music"; text: string; params: Record<string, unknown>;
};
export type RenderRequest = VideoRenderRequest | StillRenderRequest | AudioRenderRequest;

/** An asynchronous job at the vendor: what to ask after, and where. */
export type RenderHandle = { provider: ProviderId; ref: string; model: string; endpoint?: string };

/** Bytes back from a synchronous engine, with what it charged. */
export type Produced = {
  bytes: Buffer; mime: string; costUsd: number | null; totalTokens: number | null;
  via?: string; credits?: number | null; requestId?: string | null;
};
export type RenderOutcome = { handle: RenderHandle } | { produced: Produced };

export type PollResult = {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  videoUrl: string | null; totalTokens: number | null; error: string | null;
  vendorStartedAt: number | null; vendorEndedAt: number | null; raw: unknown;
};

export type TextRun = { body: string; auth?: Record<string, string>; timeoutMs?: number; mock?: "prompt" | "turn" | "idea" | "scene" | "shots" };

/** Prompt enhancement (brief 1.8): an idea, the engine it is for, and what the compiler knows — Setup, cast, rules — in; a prompt in that engine's dialect out. */
export type EnhanceRequest = {
  prompt: string; targetEngine: string; durationS?: number; task?: string; citations?: string[];
  setup?: Record<string, string>; cast?: string[]; rules?: string; style?: string;
};
export type EnhanceResult = { text: string; model: string; inTokens: number; outTokens: number; costUsd: number | null; move?: string | null };

export type EngineAdapter = {
  id: ProviderId;
  kinds: EngineKind[];
  configured(): boolean;
  /** What a job will cost at the vendor, in dollars — null when the engine bills by what it delivers. */
  estimate(req: RenderRequest): number | null;
  /** Start a job. An asynchronous engine returns a handle to poll; a synchronous one returns what it made. */
  render(req: RenderRequest): Promise<RenderOutcome>;
  /** Ask after an asynchronous job. Throws when the vendor cannot be reached; the caller decides what a throw means. */
  poll?(handle: RenderHandle): Promise<PollResult>;
  /** The master's bytes from where the vendor left them. */
  fetchMaster?(url: string): Promise<Buffer>;
  /** A text call — the thinking engine's shape. */
  run?(req: TextRun): Promise<{ ok: boolean; status: number; text: string }>;
  /** Prompt enhancement, priced like any render: estimateText says what a call costs at list price. */
  enhance?(req: EnhanceRequest): Promise<EnhanceResult>;
  estimateText?(model: string, promptChars: number, styleChars?: number): number | null;
};
