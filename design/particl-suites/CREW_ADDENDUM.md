# Crew — addendum to the Particl Suites handoff

Crew is an **additive module**. It does not touch the eight production stages, Gen, Business, Viral or Atomik. New route, new tables, new API routes, one new header tab. Design reference: `Particl Crew.dc.html` (same Graphite tokens; the header links back to the main shell). The prototype runs its brainstorm on the sandbox's Claude helper so it is clickable; production uses **xAI Grok 4.6** with the workspace's `XAI_API_KEY`.

## What it is
A brainstorming room for a project. The user seats **crew members** — each one is a Grok agent with a role card (name, department, stance = system prompt, reasoning effort). They write a **goal**, choose what project context the room reads (Brief, Script, Boards, Cast, Rig), and **run a round**. A round has three phases:

1. **Propose** — every seated member answers the goal with one concrete proposal (≤60 words, first person).
2. **Challenge** — every member picks another member's proposal (`@Name — …`) and sharpens it or pushes back with a reason.
3. **Converge** — the **chair** (default: Producer) merges the room into exactly three numbered **solutions** (`n. Title — what we do`).

Solutions collect in the session panel with actions **→ Brief**, **Board it**, **Open in Gen**, Remove. Any transcript message can be **pinned** as a solution. The user can **interject** at any time ("You · Producer's desk"); members read it next round. Rounds cost `seated members + 1` cr (placeholder — bill on Grok tokens returned, rate-snapshot per round like renders).

## Screens (all inside the existing shell)
- **Header**: sixth suite tab **Crew** after Atomik (main shell: `<a>`; in the app: a real suite id `crew`). Stage strip: `01 Room · 02 Members · 03 Sessions`, status pill "Grok 4.6 · multi-agent · xAI key connected" (green dot; red + "Add key in Workspace › Engines" when missing).
- **Room** — three columns: **Roster** (280): member cards (colour dot, name, department, status line *thinking… / chair · medium effort*, on/off switch = mute for the next round), `Add a member…` select of remaining presets + *Custom role…*. **Room** (1fr): project pill, title, `Run round · n cr` primary (disabled with the reason inline: *Write the goal.* / *Seat at least one member.*), Goal card (textarea, *Room reads* context chips, phase segment Propose | Challenge | Converge that lights during a run), transcript (round headers, message cards with dot · name · department · PHASE tag · *Pin*; challenges indented 24px with `↳ to Name`; converge card tinted `rgba(10,132,255,0.10)`), *thinking…* row while a member runs, interject input + Send. **Session panel** (320): eyebrow SESSION, goal, rows Members · Engine · Rounds · Reads · Spend, Solutions list, *Export minutes · free*. Clicking a member swaps the panel to its **role card**: Role input, Stance textarea, Reasoning effort Low | Medium | High, *Make chair*, *Remove from crew*.
- **Members** — grid of the seven preset role cards (Director, DOP, Production designer, Costume stylist, Editor, Producer, Continuity supervisor — the same crew the Atomik agent page lists) with stance and *Seat in room*.
- **Sessions** — rows: goal · `rounds · solutions · cr` · date · *Reopen*.

## Data model
```
crew_members   id, project_id, preset_id|null, name, department, stance, effort(low|medium|high), color, active, is_chair, order
crew_sessions  id, project_id, goal, context{brief,script,boards,cast,rig}, model, rounds_run, spend_cr, created_by, created_at
crew_messages  id, session_id, round, phase(propose|challenge|converge|note), member_id|null (null = human), to_member_id|null, text, tokens_in, tokens_out, created_at
crew_solutions id, session_id, round, text, source(converge|pin), status(open|sent_to_brief|boarded|generated)
```

## API (server-side; the key never reaches the browser)
- `POST /api/crew/sessions` `{ projectId, goal, context }` → session.
- `POST /api/crew/sessions/:id/rounds` → runs one round, streams SSE events: `phase`, `thinking {memberId}`, `message {…}`, `solutions [...]`, `done {spendCr}`. Debit credits on `done`; never bill a failed round.
- `POST /api/crew/sessions/:id/notes` `{ text }` → human interjection (phase `note`).
- `POST /api/crew/solutions/:id/route` `{ to: 'brief'|'boards'|'gen' }` → appends to the Brief document, creates a Boards frame request, or opens Gen with the text as the prompt preset.
- `GET /api/crew/sessions/:id/minutes` → Markdown (goal, roster, transcript, solutions) saved into Assets.

## Grok 4.6 orchestration (xAI)
- Endpoint: `POST https://api.x.ai/v1/chat/completions` (OpenAI-compatible; the Responses API `POST https://api.x.ai/v1/responses` also works). Header `Authorization: Bearer ${XAI_API_KEY}`. Model id from env `XAI_MODEL` (default `grok-4.6`; confirm the exact id and any `-fast` / reasoning variants in the xAI console before shipping — pick one per member effort: low → fast variant, medium/high → full model with `reasoning_effort` where supported).
- **One agent per member, one request per member per phase.** The "multi-agent" behaviour is our orchestration: run the Propose phase's requests **in parallel** (`Promise.all`, cap 6), then Challenge in parallel with the full Propose transcript in context, then a single Converge request to the chair. Stream each completion to the room as it lands.
- Per-request body: `{ model, messages: [{role:'system', content: ROLE_CARD}, {role:'user', content: GOAL + TRANSCRIPT}], temperature: 0.7 (propose) | 0.5 (challenge) | 0.2 (converge), max_tokens: 220, stream: true }`.
- `ROLE_CARD` = `You are {name} ({department}) in a film crew brainstorm. {stance}\n{PROJECT CONTEXT — only the sections the session's context flags enable, pulled live from the project's brief, script, boards, cast and rig}\nReasoning effort: {effort}.\n{PHASE INSTRUCTION}` where the phase instructions are exactly:
  - Propose: `PHASE: PROPOSE. Give ONE concrete proposal answering the goal, ≤60 words, in first person, no preamble.`
  - Challenge: `PHASE: CHALLENGE. Pick one other member's proposal, start with "@Name —", then sharpen it or push back with a specific reason, ≤60 words.`
  - Converge: `PHASE: CONVERGE. You chair the room. Merge the strongest ideas into exactly 3 numbered solutions, one line each: "1. Title — what we do, ≤25 words". Output only the three lines.`
- Parse challenges with `/^@([^—\-:]+)/` to set `to_member_id`; parse converge lines with `/^\d+\./` into `crew_solutions`.
- Guardrails: hard cap `roundsMax` per session (default 6, tweakable); per-member `max_tokens` 220; timeouts 45 s per request with one retry; if the chair fails, keep the round's messages and show *Converge failed — run again (not billed)*.
- Cost: convert `usage.prompt_tokens + completion_tokens` to cr with the workspace rate card; store per message; `spend_cr` on the session; failed requests are not billed.
- Key management: `XAI_API_KEY` in **Workspace › Engines** as a new row **xAI · Grok** (Connect / Verify — Verify lists models only). Encrypted at rest, never returned to the client.

## Prompt for Claude Code (paste after the main prompt, or as a new task)
> Read `design_handoff_particl_suites/CREW_ADDENDUM.md` and open `Particl Crew.dc.html` in a browser. Add the Crew module to the app as described: new suite tab **Crew** after Atomik, pages Room · Members · Sessions, the four tables, the API routes, and the xAI Grok 4.6 orchestration (parallel per-phase requests, one agent per member, chair converges, SSE streaming to the room). Use `XAI_API_KEY` / `XAI_MODEL` from env, surfaced in Workspace › Engines as an *xAI · Grok* row. Match the prototype's layout, tokens and copy exactly; the prototype's phase instructions and parsing regexes are the spec. Bill rounds on tokens returned; never bill failed requests. Do not modify Studio, Gen, Business, Viral or Atomik beyond adding the tab and the three solution routes (→ Brief, Board it, Open in Gen). Ship Room first (with real Grok calls), then Members, then Sessions.
