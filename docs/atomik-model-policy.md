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
- the workspace export carries a Studio Atomik job without its model or effort, in its request or its plan.

Every Atomik thinking prompt also tells the model not to name itself (`NO_MODEL_NAME`).

The rows behind them keep the model and effort, for settlement and the platform admin. tests/unit/atomikNoModelDisclosure.spec.ts drives each route and checks it.

The model and effort pickers stay on the screens until the Thinking control replaces them (its own PR). Until then what a person picks there is ignored: every turn runs the setting.

Still to strip (they predate this policy and are left for their own PR):
- the pickers' menus (GET `/api/atomik`, `/api/workbench/atomik`, `/api/workbench/development`);
- an idea's saved model (GET `/api/atomik/ideas`), and an idea or a Treatment scene saved before this policy, in the export;
- `/api/settings` `models.text`;
- the `/api/engines` refiner;
- `/api/platform`;
- Crew;
- the paid-text and Studio refusals that still suggest "lower effort" or "an economy model".

## Where the mapping lives

`lib/atomikModelPolicy.ts`, and nowhere else: `ATOMIK_THINKING` maps each setting to a model id and an effort.

Each entry can be overridden by env: `ATOMIK_THINKING_HIGH_MODEL` and `ATOMIK_THINKING_HIGH_EFFORT`, and the same for `MEDIUM` and `LOW`.
- A model override must be a verified Claude id from the catalogue (`VERIFIED_TEXT_MODEL_IDS`, written the catalogue's way, `anthropic/…`). The direct Anthropic door maps it to Anthropic's own id in `lib/textRoute.ts`.
- An effort override must be a named effort the reasoning compiler knows: `minimal`, `low`, `medium`, `high`, `xhigh` or `max`.
- Anything else is ignored and the default kept. A bad value never stops the app from starting.

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

If the setting's model is not being served, Atomik thinks with a served Claude model none of whose rates (input, output, cache read, cache write) is higher than the setting's own model's catalogue rates, the closest below first (`selectAtomikThinking`). A cache rate the candidate does not state is not compared yet (`CACHE_RATE_REQUIRED`, pending the owner: tests/unit/model-trace.spec.ts, a guard, serves a model priced by input and output alone); a direct door refuses such a model in any case. It never falls back to a dearer model, so a Low turn never falls back upward. The quote is the price of the model that runs. If none qualifies, the turn is refused before anything is quoted or charged, in plain words that name no model. Nothing falls back to another family.

## Families

- **Claude (Anthropic)** is the only family Atomik thinks with (`ATOMIK_FAMILIES`).
- **xAI (Grok)** has left Atomik's allowlist.
- **OpenAI** stays for one job only: the Treatment writer.

`VERIFIED_TEXT_MODEL_IDS` stays the verified text catalogue; the prompt enhancer still reads all of it. The prompt enhancer, Crew, the 3D blocking engine and the image and video engines are not Atomik's thinking, and this policy does not change them.

## The Treatment writer

`TREATMENT_WRITER` (`treatmentWriter()` in `lib/atomikModelPolicy.ts`) writes the Treatment deck's prose and nothing else; Claude, at the Thinking setting, does everything else.

The owner sets it by env: `TREATMENT_WRITER_MODEL` (an OpenAI id, `openai/<id>` or a bare `gpt-…`) and `TREATMENT_WRITER_EFFORT` (default `high`). It is read when it is needed.

With no writer set up, or one the catalogue does not serve, the Treatment's prose is refused before anything is quoted, held or charged: "The Treatment writer is not set up. Nothing billed."

## Money

Nothing is charged for the setting itself. Each turn is priced through the price path at what it runs (its estimate includes the setting's effort), and settled at what it used.

Every run of Atomik's thinking for ideas, shot lists, a Treatment scene and the memory read needs the ceiling its person approved on the quote, whatever the caller sent. Without one it is refused before anything is claimed or charged.

A chat turn keeps the earlier rule, pending the owner:
- one that carries `maxCredits` runs under that approved ceiling (the page sends it with every turn; the page no longer sends an effort);
- one that sends an effort without `maxCredits` is refused;
- one that sends neither runs under `ATOMIK_MAX_REQUEST_USD` alone: $1 when it is unset, at most $5 when it is set.

This policy carries no band figure: each setting's band rates sit in the private policy and come with their own money PR.

This policy does not change generation-engine selection, the rate card or already accepted job identity. Future model additions require an explicit policy update with evidence. Atomik never uses a signed-in Higgsfield account (owner, 28 September 2026).
