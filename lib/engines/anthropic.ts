import type { EngineAdapter } from "./types";
import { textPost } from "../textDirect";
import { isTextDirect } from "../textDirectVendors";
import { vendorKey } from "../vendorKeys";
import { engineMock } from "../mock";

/**
 * Anthropic's own API, for Claude text once TEXT_DIRECT lists it. It only
 * thinks: every call goes through the text router (lib/textDirect.ts), which
 * decides the door from TEXT_DIRECT, so this adapter adds no path of its own.
 * Registered so the provider row (lib/providers.ts) has its engine.
 */
export const anthropic: EngineAdapter = {
  id: "anthropic",
  kinds: ["text"],
  configured: () => engineMock() || (isTextDirect("anthropic") && Boolean(vendorKey("anthropic"))),
  estimate: () => null,
  async render() { throw new Error("Claude writes text; it renders nothing."); },
  run: (req) => textPost(req.body, { auth: req.auth, timeoutMs: req.timeoutMs, mock: req.mock }),
};
