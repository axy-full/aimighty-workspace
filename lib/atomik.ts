import { db, ready, now, id as newId } from "./db";
import { gatewayAuth, gatewayReachable, explainGatewayFailure } from "./gateway";
import { catalog, findModel, FEATURED, videoCostUsd, imageCostUsd, textCostUsd } from "./catalog";
import { MODELS, estimateCostUsd, estimateImageCostUsd } from "./models";
import { gatewayPost } from "./gateway";
import { meter } from "./meter";
import { getPlatformLayer } from "./platform";
import { textModelFor } from "./platformLayer";

/**
 * Atomik — the studio's agent.
 *
 * Particl is a good instrument and a poor producer. It renders exactly the
 * shot you describe, one at a time, and everything above that — what the
 * shots should BE, in what order, on which engine, at what cost — comes out
 * of the person at the keyboard. That is the work people have been doing
 * with Claude open in another window.
 *
 * Atomik does it in the app: you describe a production, it works out the
 * shots, and it proposes each generation to you one at a time with the
 * price on the button. Nothing is spent until someone presses Approve.
 *
 * The planner is whichever model you choose from the Vercel AI Gateway, and
 * that is the point of the section — the reasoning that used to need a
 * Claude subscription now comes out of a menu, with Claude as one row in it
 * rather than a prerequisite.
 *
 * WHY A JSON PROTOCOL AND NOT TOOL CALLS. The obvious build is OpenAI-style
 * `tools` with `tool_calls` back. It is also the one that quietly defeats
 * the purpose: tool-calling support across the gateway's vendors is uneven,
 * and the models most worth offering to someone without a Claude plan — the
 * cheap, fast Chinese and open-weight ones — are exactly where it is
 * patchiest. So a turn is one JSON object instead. Every model that can
 * follow an instruction can produce it, which is the whole menu.
 */

/* ── Shapes ───────────────────────────────────────────────────────────── */

export type StepKind = "video" | "image" | "audio";
export type StepStatus = "proposed" | "running" | "done" | "failed" | "rejected";
export type ChatStatus = "idle" | "running" | "waiting" | "failed";
export type AgentMode = "ask" | "auto";

export type Step = {
  id: string; chatId: string; messageId: string; position: number;
  kind: StepKind; title: string; prompt: string; model: string;
  params: Record<string, unknown>;
  status: StepStatus; genId: string | null;
  estCostUsd: number | null; error: string | null;
  createdAt: number;
};

export type Ask = { question: string; options: string[] };

export type Message = {
  id: string; chatId: string; role: "user" | "assistant";
  text: string; activity: string[]; ask: Ask | null;
  workedMs: number | null; costUsd: number; model: string;
  createdAt: number;
};

export type Chat = {
  id: string; projectId: string | null; title: string;
  model: string; agentMode: AgentMode; status: ChatStatus;
  textCostUsd: number; createdBy: string;
  createdAt: number; updatedAt: number;
};

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Row = any;

const jsonOr = <T,>(raw: unknown, fallback: T): T => {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};

const toStep = (r: Row): Step => ({
  id: String(r.id), chatId: String(r.chat_id), messageId: String(r.message_id ?? ""),
  position: Number(r.position ?? 0), kind: String(r.kind) as StepKind,
  title: String(r.title ?? ""), prompt: String(r.prompt ?? ""), model: String(r.model ?? ""),
  params: jsonOr<Record<string, unknown>>(r.params, {}),
  status: String(r.status ?? "proposed") as StepStatus,
  genId: r.gen_id ? String(r.gen_id) : null,
  estCostUsd: r.est_cost_usd == null ? null : Number(r.est_cost_usd),
  error: r.error ? String(r.error) : null,
  createdAt: Number(r.created_at ?? 0),
});

const toMessage = (r: Row): Message => ({
  id: String(r.id), chatId: String(r.chat_id),
  role: String(r.role) as "user" | "assistant",
  text: String(r.text ?? ""),
  activity: jsonOr<string[]>(r.activity, []),
  ask: jsonOr<Ask | null>(r.ask, null),
  workedMs: r.worked_ms == null ? null : Number(r.worked_ms),
  costUsd: Number(r.cost_usd ?? 0), model: String(r.model ?? ""),
  createdAt: Number(r.created_at ?? 0),
});

const toChat = (r: Row): Chat => ({
  id: String(r.id), projectId: r.project_id ? String(r.project_id) : null,
  title: String(r.title ?? "New chat"), model: String(r.model ?? "auto"),
  agentMode: String(r.agent_mode ?? "ask") as AgentMode,
  status: String(r.status ?? "idle") as ChatStatus,
  textCostUsd: Number(r.text_cost_usd ?? 0), createdBy: String(r.created_by ?? ""),
  createdAt: Number(r.created_at ?? 0), updatedAt: Number(r.updated_at ?? 0),
});

/* ── Chats ────────────────────────────────────────────────────────────── */

export async function listChats(limit = 40): Promise<(Chat & { needsApproval: boolean })[]> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT c.*, EXISTS(
            SELECT 1 FROM atomik_steps s WHERE s.chat_id = c.id AND s.status = 'proposed'
          ) AS needs
          FROM atomik_chats c WHERE c.deleted = 0
          ORDER BY c.updated_at DESC LIMIT ?`,
    args: [Math.min(Math.max(1, limit), 100)],
  });
  return rs.rows.map((r: Row) => ({ ...toChat(r), needsApproval: Number(r.needs) === 1 }));
}

export async function createChat(opts: {
  userId: string; projectId: string | null; model: string; agentMode: AgentMode;
}): Promise<string> {
  await ready();
  const chatId = newId("ach");
  const ts = now();
  await db().execute({
    sql: `INSERT INTO atomik_chats
            (id, project_id, title, model, agent_mode, status, text_cost_usd,
             created_by, created_at, updated_at, deleted)
          VALUES (?,?,?,?,?,'idle',0,?,?,?,0)`,
    args: [chatId, opts.projectId, "New chat", opts.model, opts.agentMode, opts.userId, ts, ts],
  });
  return chatId;
}

export async function getChat(chatId: string): Promise<{
  chat: Chat; messages: Message[]; steps: Step[];
} | null> {
  await ready();
  const c = await db().execute({
    sql: `SELECT * FROM atomik_chats WHERE id = ? AND deleted = 0`, args: [chatId],
  });
  if (!c.rows.length) return null;
  const m = await db().execute({
    sql: `SELECT * FROM atomik_messages WHERE chat_id = ? ORDER BY created_at ASC, rowid ASC`,
    args: [chatId],
  });
  const s = await db().execute({
    sql: `SELECT * FROM atomik_steps WHERE chat_id = ? ORDER BY created_at ASC, position ASC`,
    args: [chatId],
  });
  return { chat: toChat(c.rows[0]), messages: m.rows.map(toMessage), steps: s.rows.map(toStep) };
}

export async function patchChat(chatId: string, patch: {
  title?: string; model?: string; agentMode?: AgentMode;
  status?: ChatStatus; projectId?: string | null;
}): Promise<void> {
  await ready();
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (patch.title != null) { sets.push("title = ?"); args.push(patch.title.slice(0, 80)); }
  if (patch.model != null) { sets.push("model = ?"); args.push(patch.model); }
  if (patch.agentMode != null) { sets.push("agent_mode = ?"); args.push(patch.agentMode); }
  if (patch.status != null) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.projectId !== undefined) { sets.push("project_id = ?"); args.push(patch.projectId); }
  if (!sets.length) return;
  sets.push("updated_at = ?"); args.push(now(), chatId);
  await db().execute({ sql: `UPDATE atomik_chats SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function deleteChat(chatId: string): Promise<void> {
  await ready();
  /* The transcript and the proposals go with the conversation. A chat is
     soft-deleted so the id stays resolvable, but its messages and steps are
     only ever read through it — leaving them would accumulate rows nothing
     can reach, in the two tables that grow fastest. Renders are untouched:
     an approved step became an ordinary generation and belongs to the
     project now, not to the conversation that suggested it. */
  await db().execute({ sql: `DELETE FROM atomik_messages WHERE chat_id = ?`, args: [chatId] });
  await db().execute({ sql: `DELETE FROM atomik_steps WHERE chat_id = ?`, args: [chatId] });
  await db().execute({
    sql: `UPDATE atomik_chats SET deleted = 1, updated_at = ? WHERE id = ?`,
    args: [now(), chatId],
  });
}

/**
 * Claim a proposed step for rendering, once.
 *
 * The single UPDATE is the whole point. Approval is the moment money is
 * spent, and everything that could approve twice — an effect re-running on
 * stale state, a double click, two tabs open on the same chat, a retried
 * request — resolves to two callers racing this row. `WHERE status =
 * 'proposed'` makes the database the arbiter: the first caller changes a
 * row and gets the step, every later one changes nothing and gets null,
 * and only a caller holding the step is allowed to spend.
 *
 * It returns the step as STORED rather than as the client remembers it, so
 * a render is always billed for what was priced, not for whatever the
 * browser had in memory when the button went down.
 */
export async function claimStep(stepId: string): Promise<Step | null> {
  await ready();
  const rs = await db().execute({
    sql: `UPDATE atomik_steps SET status = 'running', updated_at = ?
          WHERE id = ? AND status = 'proposed'`,
    args: [now(), stepId],
  });
  if (Number(rs.rowsAffected ?? 0) === 0) return null;
  return getStep(stepId);
}

/* ── Steps ────────────────────────────────────────────────────────────── */

export async function getStep(stepId: string): Promise<Step | null> {
  await ready();
  const rs = await db().execute({ sql: `SELECT * FROM atomik_steps WHERE id = ?`, args: [stepId] });
  return rs.rows.length ? toStep(rs.rows[0]) : null;
}

/**
 * Change a proposed step before it is paid for.
 *
 * This is the whole point of the approval card: it is where you change your
 * mind, not merely where you say yes. Every edit re-prices the step, so the
 * number on the button is always the number you would be charged.
 */
export async function patchStep(stepId: string, patch: {
  prompt?: string; model?: string; params?: Record<string, unknown>;
  status?: StepStatus; genId?: string | null; error?: string | null;
}): Promise<Step | null> {
  await ready();
  const cur = await getStep(stepId);
  if (!cur) return null;

  const model = patch.model ?? cur.model;
  const params = patch.params ? { ...cur.params, ...patch.params } : cur.params;
  const repriced = (patch.model || patch.params)
    ? await estimateStepUsd(cur.kind, model, params)
    : cur.estCostUsd;

  await db().execute({
    sql: `UPDATE atomik_steps
            SET prompt=?, model=?, params=?, status=?, gen_id=?, error=?, est_cost_usd=?, updated_at=?
          WHERE id=?`,
    args: [
      patch.prompt ?? cur.prompt, model, JSON.stringify(params),
      patch.status ?? cur.status,
      patch.genId !== undefined ? patch.genId : cur.genId,
      patch.error !== undefined ? patch.error : cur.error,
      repriced, now(), stepId,
    ],
  });
  return getStep(stepId);
}

/* ── What a step costs before it runs ─────────────────────────────────── */

/**
 * A step's price, or null when it genuinely cannot be known ahead of time.
 *
 * Null is a real answer, not a failure. Seedance bills against a token count
 * that depends on the pixels it ends up making, and OpenAI's image models
 * bill the same way. A number invented for those would be worse than the
 * honest blank the card shows instead — this is the figure someone presses
 * a button to accept.
 */
export async function estimateStepUsd(
  kind: StepKind, model: string, params: Record<string, unknown>,
): Promise<number | null> {
  const own = MODELS.find((m) => m.id === model);
  /* Where a value is missing, fall back to what the RENDERER would use —
     the engine's own first option — rather than to a house guess. The two
     used to differ, so a step that omitted a resolution was priced at 1080p
     and rendered at 480p. */
  const seconds = Number(params.seconds) || own?.durations[0] || 5;
  const resolution = typeof params.resolution === "string"
    ? params.resolution : (own?.resolutions[0] ?? "1080p");
  const ratio = typeof params.ratio === "string"
    ? params.ratio : (own?.ratios[0] ?? "16:9");

  if (own) {
    try {
      const r = own.kind === "image"
        ? estimateImageCostUsd(own.id, resolution)
        : estimateCostUsd(own.id, resolution, ratio, seconds);
      return r ? r.net : null;
    } catch { return null; }
  }
  if (kind === "audio") return null;   // ElevenLabs bills in credits, not dollars

  const m = await findModel(model);
  if (!m) return null;
  if (m.type === "video") return videoCostUsd(m, { seconds, resolution });
  if (m.type === "image") return imageCostUsd(m);
  return null;
}

/* ── The engines the agent may choose ─────────────────────────────────── */

export type Engine = {
  id: string; label: string; kind: StepKind; note: string; own: boolean;
  /** The options the approval card may offer for this engine. Empty means
   *  the card shows no chip for that axis, which is the honest rendering of
   *  an engine that does not take one. */
  ratios: string[]; resolutions: string[]; durations: number[];
  supportsAudio: boolean;
};

/**
 * Deliberately a short list.
 *
 * A model handed three hundred ids will invent a three-hundred-and-first,
 * and an invented id is a step that cannot run — discovered by the person
 * who has already approved the cost. Everything the agent names is checked
 * against this list and replaced if unknown.
 *
 * Only Particl's own engines can RUN today: they are wired end to end,
 * priced, stored, and land in the project like any other render. The
 * gateway's own video and image models are in the catalogue and reachable,
 * but nothing yet carries their output into storage, so offering them here
 * would be offering a button that fails.
 */
export async function engines(): Promise<Engine[]> {
  /* An engine with no generate mode (Topaz only upscales) cannot make a
     shot from a prompt, so the planner is never offered it. */
  const own = MODELS.filter((m) => !m.hidden && (m.supportsTasks ?? ["generate"]).includes("generate"));
  const out: Engine[] = own.map((m) => ({
    id: m.id, label: m.label, kind: m.kind as StepKind, own: true,
    note: m.kind === "video"
      ? `${m.durations[0]}-${m.durations[m.durations.length - 1]}s, ${m.resolutions.join("/")}, ${m.ratios.slice(0, 4).join(" ")}`
      : `stills, ${m.resolutions.join("/")}`,
    ratios: m.ratios, resolutions: m.resolutions,
    durations: m.kind === "video" ? m.durations : [],
    supportsAudio: Boolean(m.supportsAudio),
  }));
  out.push({
    id: "elevenlabs", label: "ElevenLabs", kind: "audio", own: true,
    note: "voice, sound effects and music",
    ratios: [], resolutions: [], durations: [], supportsAudio: true,
  });
  return out;
}

/* ── The turn ─────────────────────────────────────────────────────────── */

const SYSTEM = `You are Atomik, the producer inside a film studio's generation tool.

A person describes something they want made. You work out what to render, then propose each render for approval. You never spend anything yourself — every generation you propose stops at a card with a price on it, and a person presses Approve.

You reply with ONE JSON object and nothing else. No prose outside it, no code fence.

{
  "title": "3-5 word name for this chat, first reply only",
  "say": "what you tell the person: what you are making and why. Plain, brief, no bullet lists unless they help.",
  "activity": ["short past-tense notes on what you weighed, 3-8 words each"],
  "propose": [
    {
      "kind": "video" | "image" | "audio",
      "title": "3-5 word shot name",
      "prompt": "the full prompt, written to be rendered exactly as written",
      "model": "an exact engine id from the list you were given",
      "seconds": 5,
      "ratio": "16:9",
      "resolution": "1080p"
    }
  ],
  "ask": { "question": "one question", "options": ["a short answer", "another"] }
}

Every field is optional except "say". Use "ask" when a choice genuinely changes what gets made, and then propose nothing in the same reply. Ask at most one question at a time.

How to write prompts:
- Subject, action, setting, light, lens, camera move. Something a camera could execute.
- Each shot is rendered with NO knowledge of the others. Never write "the same woman as before" — describe her again, identically, every time.
- No engine names, no shot numbers, no meta-instructions inside the prompt.
- If the person named a character or place the studio has on file, use that name verbatim so it resolves.

How to plan:
- Fewer, better shots. A 30 second film is five or six shots, not fifteen.
- Obey any count, length or aspect they stated. If they stated none, choose and say so.
- When a production needs a consistent subject across shots, propose a still FIRST and say that it is the reference the shots will share.
- seconds applies to video and audio. ratio and resolution apply to video and image.`;

export type TurnResult = {
  message: Message;
  steps: Step[];
  chat: Chat;
};

/**
 * One turn: read the transcript, ask the model, persist what came back.
 *
 * The model that answers is the one the chat is set to; "auto" resolves to
 * the first featured planner the gateway is actually serving, so a chat
 * started before a model was retired still answers.
 */
export async function runTurn(chatId: string, opts: { context?: string; rules?: string } = {}): Promise<TurnResult> {
  await ready();
  const loaded = await getChat(chatId);
  if (!loaded) throw new Error("That chat is gone.");
  const { chat, messages } = loaded;

  if (!gatewayReachable()) {
    throw new Error(
      "Atomik needs the Vercel AI Gateway. Set AI_GATEWAY_API_KEY, or run on Vercel with OIDC."
    );
  }

  const model = await resolveModel(chat.model, "shot");
  const list = await engines();
  const engineText = list.map((e) => `  ${e.id} — ${e.label} (${e.kind}). ${e.note}`).join("\n");

  const history = messages.slice(-20).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.role === "assistant"
      ? JSON.stringify({ say: m.text, activity: m.activity, ask: m.ask ?? undefined })
      : m.text,
  }));

  const preamble = [
    "ENGINES YOU MAY CHOOSE (exact ids):", engineText,
    opts.context ? `\nTHIS PROJECT ALREADY HAS:\n${opts.context}` : "",
    opts.rules ? `\nTHE PLATFORM'S RULES, BY ENGINE — write every proposal's prompt to the rules for its engine:\n${opts.rules}` : "",
  ].filter(Boolean).join("\n");

  const started = Date.now();
  const auth = await gatewayAuth();
  const send = (msgs: { role: string; content: string }[]) =>
    gatewayPost(JSON.stringify({ model, max_tokens: 4000, messages: msgs }), { auth, timeoutMs: 180_000, mock: "turn" });

  const base = [
    { role: "system", content: SYSTEM },
    { role: "user", content: preamble },
    ...history,
  ];

  let res = await send(base);
  let raw = res.text;
  if (!res.ok) {
    const plain = explainGatewayFailure(res.status, raw);
    if (plain) throw new Error(plain);
    let msg = raw.slice(0, 300);
    try { msg = JSON.parse(raw)?.error?.message ?? msg; } catch { /* raw */ }
    throw new Error(`${model} failed (${res.status}): ${msg}`);
  }

  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  let j: any;
  try { j = JSON.parse(raw); }
  catch { throw new Error(`${model} returned something that isn't JSON.`); }
  let text: string = j.choices?.[0]?.message?.content ?? "";
  let costUsd = Number(j.usage?.cost ?? NaN);

  let turn = extractTurn(text);
  if (!turn) {
    /* One repair pass. Models that narrate before answering are common
       enough across this menu that failing here would rule out half of it. */
    res = await send([...base,
      { role: "assistant", content: text.slice(0, 4000) },
      { role: "user", content: "Return only the JSON object. No prose, no code fence." },
    ]);
    raw = res.text;
    if (res.ok) {
      try {
        j = JSON.parse(raw);
        text = j.choices?.[0]?.message?.content ?? "";
        const more = Number(j.usage?.cost ?? NaN);
        if (Number.isFinite(more)) costUsd = (Number.isFinite(costUsd) ? costUsd : 0) + more;
        turn = extractTurn(text);
      } catch { /* falls to the guard below */ }
    }
  }
  if (!turn) {
    /* Not an error worth throwing away the turn for: say so in the chat and
       let the person switch planner, which is one click away. */
    turn = {
      say: `${model} didn't answer in a form I could use. Try another planner — some models narrate instead of answering, and this one did twice.`,
      activity: [], propose: [], ask: null, title: null,
    };
  }

  if (!Number.isFinite(costUsd)) {
    const cm = await findModel(model);
    costUsd = (cm ? textCostUsd(cm, preamble.length / 4 + 900, text.length / 4) : null) ?? 0;
  }

  /* ── persist ── */
  const ts = now();
  const messageId = newId("amsg");
  await db().execute({
    sql: `INSERT INTO atomik_messages
            (id, chat_id, role, text, activity, ask, worked_ms, cost_usd, model, created_at)
          VALUES (?,?, 'assistant', ?,?,?,?,?,?,?)`,
    args: [messageId, chatId, turn.say, JSON.stringify(turn.activity),
      turn.ask ? JSON.stringify(turn.ask) : null,
      Date.now() - started, costUsd, model, ts],
  });
  await meter({ id: messageId, kind: "text", engine: "vercel", model, status: "succeeded", engineCostUsd: costUsd,
                projectId: chat.projectId, createdBy: chat.createdBy }, { critical: false });

  const saved: Step[] = [];
  let pos = 0;
  for (const p of turn.propose) {
    const stepId = newId("astp");
    const est = await estimateStepUsd(p.kind, p.model, p.params);
    await db().execute({
      sql: `INSERT INTO atomik_steps
              (id, chat_id, message_id, position, kind, title, prompt, model, params,
               status, est_cost_usd, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?, 'proposed', ?,?,?)`,
      args: [stepId, chatId, messageId, pos++, p.kind, p.title, p.prompt, p.model,
        JSON.stringify(p.params), est, ts, ts],
    });
    const s = await getStep(stepId);
    if (s) saved.push(s);
  }

  await db().execute({
    sql: `UPDATE atomik_chats
            SET status = ?, text_cost_usd = text_cost_usd + ?, updated_at = ?
                ${turn.title && chat.title === "New chat" ? ", title = ?" : ""}
          WHERE id = ?`,
    args: turn.title && chat.title === "New chat"
      ? [saved.length ? "waiting" : "idle", costUsd, ts, turn.title.slice(0, 80), chatId]
      : [saved.length ? "waiting" : "idle", costUsd, ts, chatId],
  });

  const after = await getChat(chatId);
  const message = after?.messages.find((m) => m.id === messageId);
  if (!after || !message) throw new Error("The turn was lost on the way back.");
  return { message, steps: saved, chat: after.chat };
}

/** "auto" → the first featured planner the gateway is actually serving. */
export async function resolveModel(want: string, job: "idea" | "shot" = "idea"): Promise<string> {
  if (want && want !== "auto") return want;
  const cat = await catalog();
  // "auto" is the platform's routing (brief 1.8): the layer names a model per job; the catalogue must know it.
  const routed = textModelFor((await getPlatformLayer().catch(() => null))?.models ?? null, job);
  if (cat.some((m) => m.id === routed)) return routed;
  const first = FEATURED.planner.find((id) => cat.some((m) => m.id === id));
  return first ?? "anthropic/claude-sonnet-5";
}

type ParsedTurn = {
  title: string | null;
  say: string;
  activity: string[];
  ask: Ask | null;
  propose: { kind: StepKind; title: string; prompt: string; model: string; params: Record<string, unknown> }[];
};

/** Pull the object out of whatever the model wrapped it in, and make every
 *  proposal executable or drop it. */
function extractTurn(text: string): ParsedTurn | null {
  if (!text) return null;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const tryParse = (s: string): any | null => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch { return null; }
  };
  let raw = tryParse(text.trim());
  if (!raw) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) raw = tryParse(fenced[1].trim());
  }
  if (!raw) {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a >= 0 && b > a) raw = tryParse(text.slice(a, b + 1));
  }
  if (!raw) return null;

  const say = String(raw.say ?? "").trim();
  if (!say && !Array.isArray(raw.propose)) return null;

  const defaultFor = (k: StepKind) =>
    k === "audio" ? "elevenlabs"
      : (MODELS.find((m) => !m.hidden && m.kind === k)?.id ?? MODELS[0].id);

  const propose: ParsedTurn["propose"] = [];
  for (const r of (Array.isArray(raw.propose) ? raw.propose : []).slice(0, 12)) {
    if (!r || typeof r !== "object") continue;
    const s = r as Record<string, unknown>;
    const prompt = String(s.prompt ?? "").trim();
    if (!prompt) continue;
    const kind: StepKind = s.kind === "image" ? "image" : s.kind === "audio" ? "audio" : "video";

    /* The engine has to match the KIND, not merely exist. Checking the id
       against one set and the kind against another let a "video" step be
       filed against a stills engine: it passed validation here and was
       priced as video, then rendered as whatever the engine actually is. */
    let model = String(s.model ?? "").trim();
    const named = MODELS.find((m) => !m.hidden && m.id === model);
    if (kind === "audio") model = "elevenlabs";
    else if (!named || named.kind !== kind) model = defaultFor(kind);

    /* Every axis is FILLED, and filled from the engine's own lists.
       Leaving one out meant two different defaults decided it: this file
       assumed 5s / 16:9 / 1080p when pricing, and /api/generate quietly
       used the engine's first option — 4s / adaptive / 480p — when
       rendering. The number on the Approve button was then a price for a
       render nobody was going to make. Anything the engine does not offer
       is snapped to the nearest thing it does. */
    const def = MODELS.find((m) => m.id === model);
    const params: Record<string, unknown> = {};
    if (def && kind !== "audio") {
      const wantRatio = typeof s.ratio === "string" ? s.ratio : "";
      params.ratio = def.ratios.includes(wantRatio) ? wantRatio : def.ratios[0];
      const wantRes = typeof s.resolution === "string" ? s.resolution : "";
      params.resolution = def.resolutions.find(
        (x) => x.toLowerCase() === wantRes.toLowerCase()
      ) ?? def.resolutions[0];
      if (def.durations.length) {
        const want = Number(s.seconds);
        params.seconds = Number.isFinite(want) && want > 0
          ? def.durations.reduce((best, d) =>
            Math.abs(d - want) < Math.abs(best - want) ? d : best, def.durations[0])
          : def.durations[0];
      }
    } else {
      const want = Number(s.seconds);
      if (Number.isFinite(want) && want > 0) params.seconds = Math.min(60, Math.round(want));
    }

    propose.push({
      kind, model, prompt: prompt.slice(0, 4000),
      title: String(s.title ?? "").slice(0, 60) || `Shot ${propose.length + 1}`,
      params,
    });
  }

  const askRaw = raw.ask && typeof raw.ask === "object" ? raw.ask as Record<string, unknown> : null;
  const ask: Ask | null = askRaw && String(askRaw.question ?? "").trim()
    ? {
      question: String(askRaw.question).slice(0, 400),
      options: (Array.isArray(askRaw.options) ? askRaw.options : [])
        .map((o) => String(o).slice(0, 80)).filter(Boolean).slice(0, 5),
    }
    : null;

  return {
    title: raw.title ? String(raw.title).slice(0, 80) : null,
    say: say || "Here's what I'd do.",
    activity: (Array.isArray(raw.activity) ? raw.activity : [])
      .map((a: unknown) => String(a).slice(0, 90)).filter(Boolean).slice(0, 8),
    ask, propose,
  };
}

/** Record a person's message. Returns its id. */
export async function addUserMessage(chatId: string, text: string): Promise<string> {
  await ready();
  const messageId = newId("amsg");
  const ts = now();
  await db().execute({
    sql: `INSERT INTO atomik_messages (id, chat_id, role, text, activity, created_at)
          VALUES (?,?, 'user', ?, '[]', ?)`,
    args: [messageId, chatId, text.slice(0, 8000), ts],
  });
  await db().execute({
    sql: `UPDATE atomik_chats SET updated_at = ?, status = 'running' WHERE id = ?`,
    args: [ts, chatId],
  });
  return messageId;
}

/** What the project already holds, as a line the planner can read. */
export async function projectContext(projectId: string | null): Promise<string> {
  if (!projectId) return "";
  await ready();
  const cast = await db().execute({
    sql: `SELECT name, kind, description FROM cast_members WHERE project_id = ? LIMIT 30`,
    args: [projectId],
  });
  const lines = cast.rows.map((r: Row) =>
    `  @${String(r.name)} (${String(r.kind)})${r.description ? ` — ${String(r.description)}` : ""}`);
  if (!lines.length) return "";
  return ["Named cast and locations you can refer to by name:", ...lines].join("\n");
}
