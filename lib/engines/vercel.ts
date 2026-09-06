import type { EngineAdapter } from "./types";
import { gatewayReachable, gatewayPost } from "../gateway";

/** Vercel's AI Gateway: the one thinking engine — Claude, GPT — for the prompt writer and Atomik. Priced by tokens, read off the reply. */
export const vercel: EngineAdapter = {
  id: "vercel",
  kinds: ["text", "image"],
  configured: () => gatewayReachable(),
  estimate: () => null,
  async render() { throw new Error("The gateway thinks; stills through it are rendered by the Google adapter."); },
  run: (req) => gatewayPost(req.body, { auth: req.auth, timeoutMs: req.timeoutMs, mock: req.mock }),
};
