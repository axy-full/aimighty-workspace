"use client";
import { useState } from "react";
import type { BoardCtx } from "@/components/graphite/board/cards/types";
import { Price } from "@/components/v12/ui/Price";
import { sendGenPreset } from "@/lib/shell/gen-preset";
import { spendAttrsOf } from "@/lib/spend";
import type { Quote } from "@/lib/v12/quote";
import { LINES_MAX, bedBody, bedOpening, canMakeBed, canNarrate, narrationBody, narrationOpening } from "@/lib/v12/social";
import { useAudioQuote } from "@/lib/v12/useQuote";
import { useAudioSetup } from "./use-audio-setup";
import "../stage-pages.css";
import "./social.css";

/**
 * The Voice stage (Social · narrated; docs/redesign/inventory.md § 10.2; prototype 12 "Voice"): a Narrator card and, where the
 * workspace can make music, a Music bed card. Both run on today's sound engine and are made in Make: the one filled button
 * opens Make's audio mode with the words and voice filled in, where its own button shows the same price before anything runs.
 * Nothing here spends. The price on each button is the server's live quote of the take as written (a narration is priced per
 * character, so it is "up to N cr"); with nothing written there is nothing to price, and the button says what to do first.
 * A card shows only for what this workspace can run. The rest of the prototype's Social stages (hook review, scenes from a
 * script, captions, thumbnails) have no engine yet and keep today's cards.
 */
export function VoiceStage({ ctx }: { ctx: BoardCtx }) {
  const { setup, failed } = useAudioSetup(ctx.scope);
  const [voiceId, setVoiceId] = useState("");
  const [lines, setLines] = useState("");
  const [bed, setBed] = useState("");
  const voices = setup?.voices ?? [];
  const voice = voices.find((v) => v.id === voiceId) ?? voices[0] ?? null;
  const modelId = setup?.defaultSpeechModel || setup?.speechModels?.[0]?.id || "";
  const narrate = canNarrate(setup);
  const music = canMakeBed(setup);
  const canAct = !ctx.offline && !ctx.readOnly;

  const narrationAsked = narrate && voice ? narrationBody(lines, voice.id, modelId) : null;
  const narrationQuote = useAudioQuote(narrationAsked ? { route: "audio", body: narrationAsked } : null);
  const bedAsked = music ? bedBody(bed) : null;
  const bedQuote = useAudioQuote(bedAsked ? { route: "audio", body: bedAsked } : null);

  const makeNarration = () => {
    if (!voice || !narrationAsked) return;
    sendGenPreset(narrationOpening(lines, voice.id, voice.name));
    ctx.openMake("audio");
  };
  const makeBed = () => {
    if (!bedAsked) return;
    sendGenPreset(bedOpening(bed));
    ctx.openMake("audio");
  };

  return (
    <div className="v12-sp v12-so v12-so-voice" data-testid="v12-voice-stage">
      <header className="v12-so-bar">
        <h2 className="v12-sp-title">Voice</h2>
        <p className="v12-sp-why" data-testid="v12-voice-line">Write the lines. Make reads them in the voice you pick, and shows its price before anything runs.</p>
      </header>

      <section className="v12-sp-card" aria-labelledby="v12-vo-narrator-h" data-testid="v12-narrator">
        <header className="v12-sp-head"><span className="v12-sp-eyebrow">Narrator</span><span className="v12-sp-state">{narrate ? "Picked" : "Not set up"}</span></header>
        <h3 className="v12-sp-title" id="v12-vo-narrator-h">{voice ? voice.name : setup || failed ? "No voice yet" : "Reading the voices…"}</h3>
        {failed ? <p className="v12-sp-why v12-sp-problem" role="alert" data-testid="v12-voice-failed">{failed}</p> : null}
        {setup && !setup.configured ? <p className="v12-sp-why" data-testid="v12-voice-off">Sound is not connected for this workspace.</p> : null}
        {setup?.configured && !narrate ? <p className="v12-sp-why" data-testid="v12-voice-off">This workspace has no voice to read in.</p> : null}
        {narrate ? (
          <>
            <label className="v12-so-field"><span className="v12-sp-eyebrow">Voice</span>
              <select className="v12-sp-select" value={voice?.id ?? ""} onChange={(e) => setVoiceId(e.target.value)} disabled={!canAct || !voices.length} data-testid="v12-voice-pick">
                {voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
            <label className="v12-so-field"><span className="v12-sp-eyebrow">Lines</span>
              <textarea className="v12-so-text" rows={5} maxLength={LINES_MAX} value={lines} onChange={(e) => setLines(e.target.value)} placeholder="What the narrator says, in order." disabled={!canAct} data-testid="v12-voice-lines" />
            </label>
            <div className="v12-sp-acts">
              <button type="button" className="v12-sp-btn v12-sp-primary" onClick={makeNarration} disabled={!canAct || !narrationAsked || narrationQuote.state !== "ready"} data-testid="v12-voice-make" {...spendAttrsOfQuote(narrationQuote)}>
                {narrationAsked ? <>Make the narration · <Price quote={narrationQuote} /></> : "Write the lines first"}
              </button>
              <button type="button" className="v12-sp-btn" onClick={() => ctx.askAtomik("Write the narration lines for this video: ")} data-testid="v12-voice-ask">Ask Atomik</button>
            </div>
          </>
        ) : null}
      </section>

      {music ? (
        <section className="v12-sp-card" aria-labelledby="v12-vo-bed-h" data-testid="v12-bed">
          <header className="v12-sp-head"><span className="v12-sp-eyebrow">Music bed</span><span className="v12-sp-state">Instrumental</span></header>
          <h3 className="v12-sp-title" id="v12-vo-bed-h">A bed under the narration</h3>
          <label className="v12-so-field"><span className="v12-sp-eyebrow">Describe it</span>
            <textarea className="v12-so-text" rows={2} maxLength={LINES_MAX} value={bed} onChange={(e) => setBed(e.target.value)} placeholder="The mood, the tempo, the instruments." disabled={!canAct} data-testid="v12-bed-text" />
          </label>
          <div className="v12-sp-acts">
            <button type="button" className="v12-sp-btn" onClick={makeBed} disabled={!canAct || !bedAsked || bedQuote.state !== "ready"} data-testid="v12-bed-make" {...spendAttrsOfQuote(bedQuote)}>
              {bedAsked ? <>Make a bed · <Price quote={bedQuote} /></> : "Describe the bed first"}
            </button>
            <button type="button" className="v12-sp-btn" onClick={() => ctx.askAtomik("Describe a music bed for this video: ")} data-testid="v12-bed-ask">Ask Atomik</button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** The control's spend marker: the quote's own figure once it has one, else unpriced (and disabled). */
function spendAttrsOfQuote(quote: Quote) {
  if (quote.state === "ready") {
    const price = quote.price;
    return price.unit === "cr" ? spendAttrsOf(price.value) : { "data-spend": "priced" as const, "data-spend-price": `$${price.usd.toFixed(2)}` };
  }
  return { "data-spend": "unpriced" as const };
}
