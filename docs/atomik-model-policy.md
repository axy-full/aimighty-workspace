# Atomik's thinking

Owner, 22 October 2026 (Amendment (iii), section E): "lets have 3 settings. High (Fable 5.1/55 high when it launches) Medium (Opus 5.5 high) Low (Sonnet 5.5 high) (never disclose to the user the models and effort settings".

## What a person sees

Atomik's thinking has three settings, shown only as **High · Medium · Low** under the word Thinking. The model behind each setting and its effort are never shown to a person: not in the UI, History, receipts, exports, the API, error messages or "How Particl works". (Until the Thinking control replaces it in its own PR, the screens still show the older model picker, whose choice is now ignored; until a later PR strips them, API responses still carry model ids.)

## Where the mapping lives

`lib/atomikModelPolicy.ts`, and nowhere else. `ATOMIK_THINKING` maps each setting to a model id and an effort:

| Setting | Model | Effort |
|---|---|---|
| High | Claude Fable 5.1 (`anthropic/claude-fable-5.1`) | high |
| Medium (the default) | Claude Opus 5.5 (`anthropic/claude-opus-5.5`) | high |
| Low | Claude Sonnet 5.5 (`anthropic/claude-sonnet-5.5`) | high |

High moves to Fable 5.5 when it ships, by a policy update with evidence.

Each entry can be overridden by env: `ATOMIK_THINKING_HIGH_MODEL` and `ATOMIK_THINKING_HIGH_EFFORT`, and the same for `MEDIUM` and `LOW`. A model override must be a verified Claude id from the catalogue (`VERIFIED_TEXT_MODEL_IDS`, written the catalogue's way, `anthropic/…`; the direct Anthropic door maps it to Anthropic's own id in `lib/textRoute.ts`). An effort override must be a named effort the reasoning compiler knows: `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Anything else is ignored and the default kept. A bad value never stops the app from starting.

## Which turns run at which setting

`thinkingFor(setting, turn)`:

- The interview (the Brief's questions), the plan and every Writing and Design turn run at the setting.
- The judge (Reviewing), digests and routine turns run at Low, unless the setting is High.

Today's turns: a chat turn and a board plan are plans. Ideas, shot lists and the development agent's writing steps are Writing. The development agent's frames, sketch, cast, environment and Rig steps, and a reference-ad review, are Design. The memory read and a condense are routine. A Verify check is the judge.

The setting's effort is sent wherever the model's catalogue entry offers it. Where the entry offers no effort control, none is sent and the model thinks at its own default. The board planner sends no effort of its own: its fixed output ceiling holds both the thinking and the answer.

## Where the setting is set

- The workspace default is the setting `atomikThinking` (`high`, `medium` or `low`; default `medium`). Only a workspace admin sets it (PATCH `/api/settings`, like every workspace setting), and any other value is refused.
- The per-production setting, at the Brief (default Medium), comes with the Brief's own PR. Until then every production follows the workspace's setting.

## A model a request names is not a choice

Every Atomik turn's model and effort come from the setting. A model or effort a request sends (older pages echo the quote's back) is ignored, never refused. A chat stored on any model still answers: its stored model is not asked, and each turn stores what it ran. If the setting's model is not being served, the turn is refused before anything is quoted or charged, in plain words that name no model. Nothing falls back to another paid model.

## Families

- **Claude (Anthropic)** is the only family Atomik thinks with (`ATOMIK_FAMILIES`).
- **xAI (Grok)** has left Atomik's allowlist.
- **OpenAI** stays for one job only: the Treatment writer.

`VERIFIED_TEXT_MODEL_IDS` stays the verified text catalogue; the prompt enhancer still reads all of it. The prompt enhancer, Crew, the 3D blocking engine and the image and video engines are not Atomik's thinking, and this policy does not change them.

## The Treatment writer

`TREATMENT_WRITER` (`treatmentWriter()` in `lib/atomikModelPolicy.ts`) writes the Treatment deck's prose and nothing else; Claude, at the Thinking setting, does everything else. The owner sets it by env: `TREATMENT_WRITER_MODEL` (an OpenAI id, `openai/<id>` or a bare `gpt-…`) and `TREATMENT_WRITER_EFFORT` (default `high`). It is read when it is needed. With no writer set up, or one the catalogue does not serve, the Treatment's prose is refused before anything is quoted, held or charged: "The Treatment writer is not set up. Nothing billed."

## Money

Nothing is charged for the setting itself. Each turn is priced through the price path at what it runs, and settled at what it used. This policy carries no band figure: each setting's band rates sit in the private policy and come with their own money PR.

This policy does not change generation-engine selection, the rate card or already accepted job identity. Future model additions require an explicit policy update with evidence. Atomik never uses a signed-in Higgsfield account (owner, 28 September 2026).
