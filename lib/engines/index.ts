import type { EngineAdapter, EngineKind } from "./types";
import type { ProviderId } from "../providers";
import { byteplus } from "./byteplus";
import { fal } from "./fal";
import { google } from "./google";
import { elevenlabs } from "./elevenlabs";
import { vercel } from "./vercel";
import { higgsfield } from "./higgsfield";
import { openai } from "./openai";
import { xai } from "./xai";

/** Every engine there is. Adding a vendor is one file above and one line here. */
export const ENGINES: Record<ProviderId, EngineAdapter> = { byteplus, fal, google, elevenlabs, vercel, higgsfield, openai, xai };

export function engineFor(id: string | null | undefined): EngineAdapter {
  const e = ENGINES[(id ?? "byteplus") as ProviderId];
  if (!e) throw new Error(`No engine adapter for "${id}".`);
  return e;
}

export const enginesFor = (kind: EngineKind): EngineAdapter[] => Object.values(ENGINES).filter((e) => e.kinds.includes(kind));

export type { EngineAdapter, EngineKind, RenderRequest, RenderHandle, RenderOutcome, PollResult, Produced } from "./types";
