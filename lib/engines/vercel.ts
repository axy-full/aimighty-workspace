import type { EngineAdapter } from "./types";
import { gatewayChat, gatewayReachable, gatewayPost } from "../gateway";
import { enhancePrompt } from "../enhance";
import { estimateRefineUsd } from "../refineGate";

/** Vercel's AI Gateway: the one thinking engine — Claude, GPT — for the prompt writer and Atomik. Priced by tokens, read off the reply. */
export const vercel: EngineAdapter = {
  id: "vercel",
  kinds: ["text", "image"],
  configured: () => gatewayReachable(),
  estimate: () => null,
  async render() { throw new Error("The gateway thinks; stills through it are rendered by the image adapter."); },
  run: (req) => gatewayPost(req.body, { auth: req.auth, timeoutMs: req.timeoutMs, mock: req.mock }),
  chat: (req) => gatewayChat(req),
  /** enhance(prompt, targetEngine, setup, cast, rules): the writer, told the target engine's dialect, with what the compiler knows as its style block. */
  async enhance(req) {
    const style = [
      req.style ?? "",
      req.setup && Object.keys(req.setup).length ? `THE SHOT'S SETUP\n${Object.entries(req.setup).map(([k, v]) => `${k}: ${v}`).join(", ")}` : "",
      req.cast?.length ? `THE CAST\n${req.cast.map((c) => `@${c}`).join(", ")}` : "",
      req.rules ? `THE RULES\n${req.rules}` : "",
    ].filter(Boolean).join("\n\n");
    const r = await enhancePrompt({ prompt: req.prompt, citations: req.citations ?? [], model: req.targetEngine, durationS: req.durationS, task: req.task, style, provider: "gateway" });
    return { text: r.text, model: r.model, inTokens: r.inTokens, outTokens: r.outTokens, costUsd: r.costUsd ?? null, move: r.move ?? null };
  },
  estimateText: (model, promptChars, styleChars = 0) => estimateRefineUsd(model, promptChars, styleChars),
};
