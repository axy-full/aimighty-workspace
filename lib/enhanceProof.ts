import { db, ready } from "./db";
import { ENHANCE_MAX_PROMPT, parseEnhanced } from "./shell/enhancer";

/**
 * Whether a paid enhancement really ran for these words in this workspace (Make's Enhance button, lib/v12/enhance.ts).
 *
 * A take is labelled Enhanced only on this proof, never on the browser's word: the enhancer's own job (POST /api/prompt/enhance,
 * stored in the workspace's own `paid_text_jobs`, kind "enhance") must have succeeded recently with the person's typed words as
 * its input, and what it answered, read as the enhancer reads it, must be what the take is sent with. The workspace's own database
 * is the scope, so no other workspace's job can vouch for a take. A label that fails the proof is not stored.
 */
export const ENHANCE_PROOF_WINDOW_MS = 30 * 60_000;

export async function enhancementRan(typed: string, sentWords: string, at = Date.now()): Promise<boolean> {
  const from = typed.trim().slice(0, ENHANCE_MAX_PROMPT);
  const sent = sentWords.replace(/\s+/g, " ").trim();
  if (!from || !sent) return false;
  try {
    await ready();
    const rows = (await db().execute({
      sql: "SELECT request_body, response_json FROM paid_text_jobs WHERE kind = 'enhance' AND status = 'succeeded' AND created_at > ? ORDER BY created_at DESC LIMIT 25",
      args: [at - ENHANCE_PROOF_WINDOW_MS],
    })).rows;
    for (const row of rows) {
      const request = JSON.parse(String(row.request_body ?? "{}")) as { messages?: { role?: unknown; content?: unknown }[] };
      const user = [...(request.messages ?? [])].reverse().find((m) => m.role === "user");
      if (typeof user?.content !== "string" || user.content.trim() !== from) continue;
      /* The job keeps the provider's reply as it came (a chat completion); the enhancer reads its message, as the route does. */
      let said = String(row.response_json ?? "");
      try { const content = (JSON.parse(said) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content; if (typeof content === "string") said = content; } catch { /* not a completion: read it as the words themselves */ }
      const answer = parseEnhanced(said, from);
      if (answer.ok && sent.includes(answer.prompt)) return true;
    }
  } catch { /* no table yet, or an unreadable row: nothing is proved */ }
  return false;
}
