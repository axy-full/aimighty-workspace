/**
 * Every place in lib/ and app/ that asks a model something, or holds a way to (the closed list behind Langfuse tracing,
 * lib/modelTrace.ts). tests/unit/model-call-sites.spec.ts scans the source for the constructs below and fails when a file
 * that has one is not here, when a file's counts differ from what is listed, when a listed site is not wrapped by its id,
 * or when a listed site or file disappears. A new model call cannot land without a decision recorded here.
 *
 * - `sites`: the model call sites in the file, by the id their span carries (lib/modelTrace.ts MODEL_SITES). Each appears as
 *   `traceModelCall("<id>"`, `openModelCall("<id>"` or, for a paid-text job, runPaidText's `trace: { site: "<id>"` in the file.
 * - `door`: where a call leaves the process (or forwards to such a place); it is wrapped in `modelDoor(` unless `wrapped`
 *   says why not. A door reached without a site is still traced, as `unattributed`.
 * - `notModelCall`: the construct is there, and it is not an Atomik language-model call; says what it is instead.
 *
 * `constructs` is how many of each construct the file has (comments stripped), so another call in a listed file fails too.
 */

import ts from "typescript";

export const MODEL_CALL_CONSTRUCTS: Record<string, RegExp> = {
  generateText: /\bgenerateText\(/g,
  streamText: /\bstreamText\(/g,
  generateObject: /\bgenerateObject\(/g,
  streamObject: /\bstreamObject\(/g,
  ToolLoopAgent: /\bnew\s+ToolLoopAgent\b/g,
  Experimental_Agent: /\bnew\s+Experimental_Agent\b/g,
  doGenerate: /\.doGenerate\(/g,
  doStream: /\.doStream\(/g,
  gatewayPost: /\bgatewayPost\(/g,
  openaiDirectPost: /\bopenaiDirectPost\(/g,
  textPost: /\btextPost\(/g,
  textRun: /\btextRun\b/g,
  runPaidText: /\brunPaidText\(/g,
  gatewayChat: /\bgatewayChat\(/g,
  askGrok: /\baskGrok\(/g,
  runToolLoop: /\brunToolLoop\(/g,
  messagesCreate: /\bmessages\.create\(/g,
  /** A model API's address, or a helper that builds one: a raw fetch to a model is found by what it fetches. */
  modelApi: /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|api\.x\.ai|ai-gateway\.vercel\.sh|bytepluses\.com|\bGATEWAY_URL\(|\bOPENAI_BASE\(|\bCHAT_URL\(/g,
  /** A base-URL helper a raw fetch could be built from. */
  baseUrl: /\bGATEWAY_BASE\(|\bproviderBaseUrl\(/g,
  /** An SDK language model made (what an agent or generateText is handed). */
  languageModel: /\blanguageModel\(/g,
  /** An agent asked to answer: each one must sit inside modelDoor (agentCallsOutsideDoor). */
  agentGenerate: /\.generate\(/g,
  agentStream: /[\w$]\.stream\(/g,
};
/** Door and model names that may not be imported, exported or destructured under another name (an alias would hide a call from the scan). */
export const UNALIASABLE = [
  "generateText", "streamText", "generateObject", "streamObject", "ToolLoopAgent", "Experimental_Agent", "languageModel",
  "gatewayPost", "openaiDirectPost", "textPost", "textRun", "runPaidText", "gatewayChat", "askGrok", "runToolLoop", "enhancePrompt",
  "GATEWAY_URL", "GATEWAY_BASE", "OPENAI_BASE", "providerBaseUrl", "modelDoor", "traceModelCall", "openModelCall",
];

/** Comments out, so a sentence about a call is not a call. */
export const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");

/** How many of each construct a source has, comments stripped. */
export function constructCounts(text: string): Record<string, number> {
  const code = stripComments(text);
  const found: Record<string, number> = {};
  for (const [name, pattern] of Object.entries(MODEL_CALL_CONSTRUCTS)) {
    const n = (code.match(new RegExp(pattern.source, "g")) ?? []).length;
    if (n) found[name] = n;
  }
  return found;
}

/** Door names a source imports, exports or destructures under another name. */
export function aliasedDoors(text: string): string[] {
  const code = stripComments(text);
  const names = UNALIASABLE.join("|");
  const found = new Set<string>();
  for (const m of code.matchAll(new RegExp(`\\b(${names})\\s+as\\s+[A-Za-z_$]`, "g"))) found.add(m[1]);
  /* `const { textPost: send } = …` */
  for (const block of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g))
    for (const m of block[1].matchAll(new RegExp(`\\b(${names})\\s*:\\s*[A-Za-z_$]`, "g"))) found.add(m[1]);
  return [...found].sort();
}

/**
 * Every `.generate(` (and `identifier.stream(`) call in a source that is not inside a `modelDoor(...)` call, as "line N".
 * Read from the syntax tree, so a second agent call beside a wrapped one is found even when the file already has a modelDoor.
 */
export function agentCallsOutsideDoor(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const outside: string[] = [];
  const insideDoor = (node: ts.Node): boolean => {
    for (let at = node.parent; at; at = at.parent)
      if (ts.isCallExpression(at) && ts.isIdentifier(at.expression) && at.expression.text === "modelDoor") return true;
    return false;
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const agentCall = name === "generate" || (name === "stream" && ts.isIdentifier(node.expression.expression));
      if (agentCall && !insideDoor(node)) outside.push(`line ${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return outside;
}

/**
 * What is wrong with a set of sources against the closed list: an unlisted file with a construct, a count that differs
 * from the list, a door under another name, an agent call outside modelDoor. Empty when the tree matches the list.
 */
export function closedListProblems(sources: { file: string; text: string }[], list: ModelCallFile[] = MODEL_CALL_FILES): string[] {
  const listed = new Map(list.map((entry) => [entry.file, entry]));
  const problems: string[] = [];
  for (const { file, text } of sources) {
    const found = constructCounts(text);
    const entry = listed.get(file);
    if (Object.keys(found).length) {
      if (!entry) problems.push(`${file}: ${JSON.stringify(found)} is not in tests/helpers/modelCallSites.ts`);
      else if (JSON.stringify(Object.entries(found).sort()) !== JSON.stringify(Object.entries(entry.constructs).sort()))
        problems.push(`${file}: has ${JSON.stringify(found)}, the list says ${JSON.stringify(entry.constructs)}`);
    }
    for (const name of aliasedDoors(text)) problems.push(`${file}: ${name} is used under another name`);
    if (found.agentGenerate || found.agentStream)
      for (const at of agentCallsOutsideDoor(file, text)) problems.push(`${file}: an agent call outside modelDoor at ${at}`);
  }
  return problems;
}
/** Constructs that are AI SDK calls: their file passes `experimental_telemetry: modelTelemetry(` at least as often. */
export const SDK_CONSTRUCTS = ["generateText", "streamText", "generateObject", "streamObject", "ToolLoopAgent", "Experimental_Agent"];

export type ModelCallFile = {
  file: string;
  constructs: Record<string, number>;
  sites?: string[];
  door?: string;
  /** Why a door is not wrapped in modelDoor itself. */
  wrapped?: false | string;
  notModelCall?: string;
};

export const MODEL_CALL_FILES: ModelCallFile[] = [
  /* ── Sites ── */
  { file: "lib/atomik.ts", sites: ["atomik.turn"], constructs: { runPaidText: 1 } },
  { file: "lib/atomikMemoryRead.ts", sites: ["atomik.memory_read"], constructs: { runPaidText: 1 } },
  { file: "app/api/prompt/enhance/route.ts", sites: ["atomik.enhance"], constructs: { runPaidText: 1 } },
  { file: "app/api/atomik/ideas/draft/route.ts", sites: ["atomik.ideas"], constructs: { runPaidText: 1 } },
  { file: "app/api/atomik/shots/draft/route.ts", sites: ["atomik.shots"], constructs: { runPaidText: 1 } },
  { file: "app/api/atomik/treatment/scene/route.ts", sites: ["atomik.treatment_scene"], constructs: { runPaidText: 1 } },
  { file: "lib/workbench/rig-agent.ts", sites: ["atomik.board_planner"], constructs: { languageModel: 1 } },
  { file: "lib/workbench/development-server.ts", sites: ["atomik.development"], door: "the development agent's generate (one step per phase; two branches, one door)", constructs: { ToolLoopAgent: 1, languageModel: 1, agentGenerate: 2 } },
  { file: "lib/workbench/atomik-server.ts", sites: ["atomik.workbench"], constructs: { textRun: 3 } },
  { file: "lib/enhance.ts", sites: ["enhance.inline"], door: "the legacy Claude writer (Anthropic SDK) and the BytePlus writer (a raw fetch), inside the site", constructs: { textPost: 1, messagesCreate: 1, modelApi: 2 } },
  { file: "lib/crew/round.ts", sites: ["crew.round"], constructs: { askGrok: 1 } },

  /* ── Doors ── */
  { file: "lib/textDirect.ts", door: "textPost / textRun: the text router; generateText for a direct vendor", constructs: { generateText: 1, gatewayPost: 1, openaiDirectPost: 1, textPost: 2, textRun: 1, languageModel: 1 } },
  { file: "lib/gateway.ts", door: "gatewayPost: one POST to the gateway's chat endpoint (gatewayChat sends through it)", constructs: { gatewayPost: 2, openaiDirectPost: 1, gatewayChat: 1, modelApi: 2, baseUrl: 2 } },
  { file: "lib/openai-direct.ts", door: "openaiDirectPost: OpenAI's own text API", constructs: { openaiDirectPost: 1, modelApi: 4 } },
  { file: "lib/paidText.ts", door: "runPaidText: the shared paid-text path; it sends through textRun, and its callers are the sites", wrapped: "it reaches textRun's door; it notes the job id and the cost it works out on the call in scope", constructs: { textRun: 2, runPaidText: 1 } },
  { file: "lib/crew/xai.ts", door: "askGrok: one Grok request for Crew", constructs: { askGrok: 1, modelApi: 2 } },
  { file: "lib/workbench/rig-agent-planner.ts", door: "the board planner's agent generate", constructs: { ToolLoopAgent: 1, agentGenerate: 1 } },
  { file: "lib/workbench/suite-agent.ts", door: "the suite agent's generate", constructs: { ToolLoopAgent: 1, languageModel: 1, agentGenerate: 1 } },
  { file: "lib/astra-blender/agent.ts", door: "the 3D blocking agent's generate (two agents, one call)", constructs: { ToolLoopAgent: 2, languageModel: 1, agentGenerate: 1 } },
  { file: "lib/engines/anthropic.ts", door: "the engine registry's Claude adapter: run forwards to textPost", wrapped: "forwards to textPost, which is a door; nothing in lib/ or app/ calls the adapter's run today", constructs: { textPost: 1 } },
  { file: "lib/engines/vercel.ts", door: "the engine registry's gateway adapter: run and chat forward to textRun and gatewayChat", wrapped: "forwards to textRun and gatewayChat, which reach a door; nothing in lib/ or app/ calls the adapter's run or chat today", constructs: { textRun: 2, gatewayChat: 1 } },
  { file: "lib/llm/tool-loop.ts", door: "the replacement tool loop (B1): calls a provider model's doGenerate", wrapped: "nothing in lib/ or app/ imports it yet; runToolLoop( is a scanned construct, so the file that first calls it must be listed here as a site", constructs: { doGenerate: 1 } },

  /* ── Not Atomik language-model calls ── */
  { file: "lib/gemini.ts", notModelCall: "still images (Nano Banana) through the gateway's chat endpoint: an image engine billed as a render, not Atomik thinking", constructs: { modelApi: 2 } },
  { file: "lib/vendorImages.ts", notModelCall: "image engines through the AI SDK's image models (generateImage's doGenerate)", constructs: { doGenerate: 1, baseUrl: 1 } },
  { file: "lib/ark.ts", notModelCall: "BytePlus video engine (ModelArk) base URL", constructs: { modelApi: 1 } },
  { file: "lib/xaiVideo.ts", notModelCall: "xAI video engine base URL", constructs: { modelApi: 1 } },
  { file: "lib/xaiVoice.ts", notModelCall: "xAI voice engine base URL", constructs: { modelApi: 1 } },
  { file: "lib/openai-models.ts", notModelCall: "lists OpenAI's models to check a key; generates nothing", constructs: { modelApi: 1 } },
  { file: "lib/providers.ts", notModelCall: "the provider table's default base URLs (and providerBaseUrl itself)", constructs: { modelApi: 6, baseUrl: 1 } },
  { file: "lib/textRoute.ts", notModelCall: "the direct vendors' base URLs", constructs: { modelApi: 3 } },
  { file: "lib/language-provider.ts", notModelCall: "builds the SDK language models the doors call; sends nothing itself", constructs: { modelApi: 1, baseUrl: 1, languageModel: 4 } },
  { file: "lib/catalog.ts", notModelCall: "lists the gateway's models (GET /models) for the catalogue; generates nothing", constructs: { baseUrl: 1 } },
  { file: "lib/elevenlabs.ts", notModelCall: "ElevenLabs voice and sound engine base URL", constructs: { baseUrl: 1 } },
  { file: "lib/fal.ts", notModelCall: "fal render engines' base URL", constructs: { baseUrl: 1 } },
  { file: "app/api/platform/route.ts", notModelCall: "the platform console lists each provider's base URL; calls nothing", constructs: { baseUrl: 1 } },
];
