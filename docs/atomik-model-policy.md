# Atomik's thinking

Owner, 22 October 2026 (Amendment (iii), section E): Atomik's thinking has three settings, and the models and effort settings behind them are never disclosed to the user.

## What a person sees

Atomik's thinking has three settings, shown only as **High · Medium · Low** under the word Thinking. The model behind each setting and its effort are never shown to a person: not in the UI, History, receipts, exports, the API, error messages or "How Particl works".

What a member is sent no longer names them:
- a quote carries its price only;
- a chat and its turns carry no model or effort;
- the ideas, shot-list, Treatment-scene and memory-read replies carry none;
- a Studio Atomik job, its plan and its quote carry none (a plan's `model` says only `atomik`);
- a development quote and job carry none;
- a Verify scorecard (its list, and a check already stored) carries no judge model;
- a statement line, a usage-ledger line and a usage page line for Atomik's thinking say "Thinking";
- a failed job's error is Atomik's own words, never the provider's message ("Atomik could not finish this request. Nothing billed." where true, or what it was charged);
- the workspace export carries Atomik's thinking without its model, vendor or effort: a Studio Atomik job (its request and its plan) and its meter lines (`model` and `engine` read `atomik`);
- the pickers' menus (GET `/api/atomik`, which the chat composer reads, GET `/api/workbench/atomik` and GET `/api/workbench/development`) list no model, name, cost band or effort, and no default model: they say only whether Atomik's thinking is connected (`configured`). The pickers draw nothing without a list. Platform-admin views (the admin's text routing) keep the ids.

Every Atomik thinking prompt also tells the model not to name itself (`NO_MODEL_NAME`).

The rows behind them keep the model and effort, for settlement and the platform admin. tests/unit/atomikNoModelDisclosure.spec.ts drives each route and checks it.

The model and effort pickers stay on the screens until the Thinking control replaces them (its own PR). Until then what a person picks there is ignored: every turn runs the setting.

Still to strip (they predate this policy and are left for their own PR):
- an idea's saved model (GET `/api/atomik/ideas`), and an idea or a Treatment scene saved before this policy, in the export;
- `/api/settings` `models.text`;
- the `/api/engines` refiner;
- `/api/platform`;
- Crew;
- the paid-text and Studio refusals that still suggest "lower effort" or "an economy model".

## Where each setting's model is set

Each setting is a slot, and the deployment's env names its model (owner, 23 October 2026, option A). No slot is mapped to a model anywhere in the code; `atomikThinkingSlots()` in `lib/atomikModelPolicy.ts` reads the env each time it is asked. **The owner sets the three slots in Coolify before the deploy**, as runtime environment variables (all six below are runtime variables, read when asked, not build-time ones).

| Variable | What it holds | If unset |
|---|---|---|
| `ATOMIK_THINKING_HIGH_MODEL` | High's model | High is refused |
| `ATOMIK_THINKING_MEDIUM_MODEL` | Medium's model (the default setting) | Medium is refused |
| `ATOMIK_THINKING_LOW_MODEL` | Low's model (also the judge, digests and routine turns, unless the setting is High) | Low is refused |
| `ATOMIK_THINKING_HIGH_EFFORT`, `ATOMIK_THINKING_MEDIUM_EFFORT`, `ATOMIK_THINKING_LOW_EFFORT` | the slot's effort | `high` |

**The accepted id format** is a verified catalogue id: one of the Claude ids in `VERIFIED_TEXT_MODEL_IDS` (`CLAUDE_MODEL_IDS`), written the catalogue's way, `anthropic/claude-<name>-<major>` or `anthropic/claude-<name>-<major>.<minor>`, lower case, with the provider prefix. A vendor's own spelling (Anthropic's `claude-<name>-<major>-<minor>`) is not accepted. Surrounding space is trimmed and case is not folded.

A slot's id must also be routable on the deployment's door. On the direct Anthropic door that means it has a `DIRECT_MODEL_IDS` entry in `lib/textRoute.ts`, which maps the catalogue id to Anthropic's own: of the accepted ids, only the current generation qualifies there (the `anthropic/claude-<name>-5` and `anthropic/claude-<name>-5.<minor>` ids that the owner's key listed on 11 October 2026); the older ones (`anthropic/claude-<name>-4…` and earlier) have no direct door. A slot naming an id the door cannot route is not served, so its turns fall back as below or are refused.

- A slot that is unset, or names any other value (an id outside the verified catalogue, another family, a vendor's spelling), is empty. Every turn that needs it is refused before anything is quoted, claimed, saved or charged: "Atomik's thinking isn't connected right now. Nothing billed." A new run is refused before its request is claimed, a chat turn before the message is saved, and a board plan before its run is written; a retry under a key that already has a claim (or a board request already asked) gets that claim's saved answer instead. No other slot stands in for an empty one.
- An effort must be a named effort the reasoning compiler knows: `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Anything else reads as `high`.
- A bad value never stops the app from starting. The verified catalogue stays the source of each slot's price.

## Which turns run at which setting

`thinkingFor(setting, turn)`:

- The interview (the Brief's questions), the plan and every Writing and Design turn run at the setting.
- The judge (Reviewing), digests and routine turns run at Low, unless the setting is High.

Today's turns:

| Turn kind | Turns |
|---|---|
| Plan | a chat turn, a board plan |
| Writing | ideas, shot lists, the development agent's writing steps |
| Design | the development agent's frames, sketch, cast, environment and Rig steps; a reference-ad review |
| Routine | the memory read, a condense |
| Judge | a Verify check |

The setting's effort is sent wherever the model's catalogue entry offers it. Where the entry offers no effort control, none is sent and the model thinks at its own default. The board planner sends no effort of its own: its fixed output ceiling holds both the thinking and the answer.

## Where the setting is set

- The workspace default is the setting `atomikThinking` (`high`, `medium` or `low`; default `medium`). Only a workspace admin sets it (PATCH `/api/settings`, like every workspace setting), and any other value is refused.
- The per-production setting, at the Brief (default Medium), comes with the Brief's own PR. Until then every production follows the workspace's setting.

## A model a request names is not a choice

Every Atomik turn's model and effort come from the setting. A model or effort a request sends is ignored, never refused. A chat stored on any model still answers: its stored model is not asked, and each turn stores what it ran.

If the setting's model is set but not being served, and the checked-in catalogue states all four of its rates, Atomik thinks with another slot's model whose every rate (input, output, cache read, cache write) is no higher than the setting's own model's catalogue rates, the closest below first (`selectAtomikThinking`). If the setting's own model does not state all four, there is no fallback and the turn is refused. A candidate that does not state all four does not qualify. It never falls back to a dearer model, so a Low turn never falls back upward. The quote is the price of the model that runs. If none qualifies, the turn is refused before anything is quoted or charged ("Atomik's thinking isn't connected right now. Nothing billed."). Nothing falls back to another model or another family.

## Families

- **Claude (Anthropic)** is the only family Atomik thinks with (`ATOMIK_FAMILIES`), and only the models the three slots name (`atomikModelIds()`; owner, 23 Oct 2026, item 14). Every Atomik path (thinking, the judge, condense, the memory read, the fallback, Studio Atomik, the board planner, development) resolves to one of them. Other Claude ids stay in the verified catalogue only for features that are not Atomik's (the prompt enhancer and the inline prompt writer).
- **xAI (Grok)** has left Atomik's allowlist.
- **OpenAI** stays for one job only: the Treatment writer.

`VERIFIED_TEXT_MODEL_IDS` stays the verified text catalogue; the prompt enhancer still reads all of it. The prompt enhancer, Crew, the 3D blocking engine and the image and video engines are not Atomik's thinking, and this policy does not change them.

## The Treatment writer

`TREATMENT_WRITER` (`treatmentWriter()` in `lib/atomikModelPolicy.ts`) writes the Treatment deck's prose and nothing else; Claude, at the Thinking setting, does everything else.

The owner sets it by env: `TREATMENT_WRITER_MODEL` (an OpenAI id, `openai/<id>` or a bare `gpt-…`) and `TREATMENT_WRITER_EFFORT` (default `high`). It is read when it is needed.

The catalogue serves it, at the catalogue's price, once `lib/modelCatalog.json` holds the id: a verified OpenAI text id, or one added with `node scripts/ops/snapshot-catalog.mjs --add=<id> --only-add`. An added id is named only in the snapshot's `added` list, which every later refresh keeps, and the snapshot will not be written unless the id has the prices a quote needs.

With no writer set up, or one the catalogue does not serve, the Treatment's prose is refused before anything is quoted, held or charged: "The Treatment writer is not set up. Nothing billed."

## Money

Nothing is charged for the setting itself. Each turn is priced through the price path at what it runs (its estimate includes the setting's effort), and settled at what it used.

Every run of Atomik's thinking (a chat turn, ideas, shot lists, a Treatment scene and the memory read) needs the ceiling its person approved on the quote, whatever the caller sent (owner, 23 Oct 2026). Without one it is refused before anything is reserved or billed: for an API token or an MCP client before its request is claimed (`tokenSpendRefusal`), and for a browser session after the request is recorded (so a retry under its key gets the same answer) and before any reservation. A job is billed what it used, never past its estimate, on any door.

This policy carries no band figure: each setting's band rates sit in the private policy and come with their own money PR.

This policy does not change generation-engine selection, the rate card or already accepted job identity. Future model additions require an explicit policy update with evidence. Atomik never uses a signed-in Higgsfield account (owner, 28 September 2026).
