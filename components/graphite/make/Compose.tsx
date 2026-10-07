"use client";
import { useRef, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { isDroppable } from "@/lib/drop";
import type { MakeTool } from "@/lib/shell/make";
import { useShell } from "@/lib/shell/state";
import { CINEMA_BANK } from "@/lib/workspace/cinema-vocabulary";
import type { ComposerType } from "@/lib/workspace/composer";
import { useFilmTypeahead } from "../FilmVocabulary";
import { Glyph, type GlyphName } from "../icons";
import { priceWords } from "@/lib/shell/price-words";
import { CheckAgain } from "../CheckAgain";
import { CHECK_LINE } from "@/lib/demo/sample";
import { toolName } from "../viral/ViralView";
import { UPSCALE_NAME } from "./UpscaleTool";
import { EngineList } from "./EngineList";
import { MakePriceText, useMakePriceTitle } from "./price";
import type { MakeModel, MakePrice } from "./use-make";

const TYPES: { type: ComposerType; label: string }[] = [{ type: "video", label: "Video" }, { type: "image", label: "Image" }, { type: "audio", label: "Audio" }];
/* The quick tools under Make (the master's row): Motion transfer, Object swap, Upscale. */
const QUICK_TOOLS: { tool: MakeTool; glyph: GlyphName }[] = [{ tool: "motion", glyph: "video" }, { tool: "swap", glyph: "swap" }, { tool: "upscale", glyph: "upscale" }];
const SAY_WHAT = "Say what to make.";

/** The words of a price, for the marker a button carries. */
const priceLabelOf = (price: MakePrice) => price.about ?? priceWords(price.value);

/**
 * Make's composer, as "Make frames.dc.html" 1, 3 and 7 draw it: the words with the type switch inside their box
 * (inferred from the words until a type is picked), the references with Add, the engine line with Change, where the
 * result goes and Make at its price, then the quick tools. Make waits with its reason, and stays pressable when credits
 * are short: the take then waits, held, until they arrive (the line above says so).
 */
export function Compose({ make, scope }: { make: MakeModel; scope: string }) {
  const shell = useShell();
  const { state } = make;
  const box = useRef<HTMLTextAreaElement>(null);
  const typeahead = useFilmTypeahead({
    type: state.type, prompt: state.prompt, textarea: box, onPrompt: make.setPrompt,
    ...(make.cinemaModel ? { setup: state.cinema, onSetup: make.setCinema, bank: CINEMA_BANK } : { setup: state.shot, onSetup: make.setShot }),
  });
  const [over, setOver] = useState(false);
  /* Pressed while it waits: the reason shows (the words' own wait shows only then; any other at once). */
  const [said, setSaid] = useState(false);
  const goTitle = useMakePriceTitle(make.go.price);
  const waits = Boolean(make.go.blocked);
  const reason = make.go.blocked && (make.go.blocked !== SAY_WHAT || said) ? make.go.blocked : null;
  const press = () => {
    if (make.go.blocked) {
      setSaid(true);
      if (!state.prompt.trim()) box.current?.focus();
      return;
    }
    setSaid(false);
    make.go.press();
  };
  const recipe = make.recipe;
  const gone = recipe?.missing.filter((m) => m.gone) ?? [];
  const changed = recipe?.chips.filter((c) => c.state === "changed" && c.why) ?? [];

  return (
    <section className="gx-mk-compose" aria-label="Composer">
      {recipe ? (
        <div className="gx-mk-recipe" role="status" data-testid="gen-recipe" data-settings-only={recipe.settingsOnly ? "true" : undefined}>
          <div className="gx-mk-recipe-head">
            <span className="gx-mk-eyebrow">{recipe.settingsOnly ? "Settings from" : "Again"}</span>
            <span className="gx-mk-recipe-name" title={recipe.name ?? undefined} data-testid="gen-recipe-name">{recipe.name}</span>
            <button type="button" className="gx-mk-link" onClick={recipe.undo} data-testid="gen-recipe-undo">Undo</button>
            <button type="button" className="gx-mk-x" aria-label="Dismiss" onClick={recipe.hide} data-testid="gen-recipe-dismiss">×</button>
          </div>
          {recipe.reading ? <p className="gx-mk-line-note">Reading the take’s references…</p> : null}
          {changed.map((c) => <p key={c.key} className="gx-mk-line-note">{c.label}: {c.why}</p>)}
          {gone.length ? <p className="gx-mk-line-note" data-alert="true" data-testid="gen-recipe-missing">Not found: {gone.map((m) => m.tag ?? "a sound").join(", ")}</p> : null}
        </div>
      ) : null}

      <div className="gx-mk-words" data-filled={state.prompt.trim() ? "" : undefined}>
        <textarea ref={box} className="gx-mk-text" aria-label="What to make" rows={3} placeholder="make shot 2 at golden hour" value={state.prompt}
          onChange={(e) => { make.setPrompt(e.target.value); typeahead.track(e.target); }} {...typeahead.inputProps} data-testid="gen-prompt" />
        {typeahead.list}
        <div className="gx-mk-typerow">
          <div className="gx-seg gx-seg--sm" role="radiogroup" aria-label="Type">
            {TYPES.map(({ type, label }) => (
              <button key={type} type="button" role="radio" className="gx-seg-btn" aria-checked={state.type === type} onClick={() => make.pickType(type)} data-testid={`make-type-${type}`}><span>{label}</span></button>
            ))}
          </div>
          {make.typeNote ? <span className="gx-mk-note" data-testid="make-type-note">{make.typeNote}</span> : null}
        </div>
      </div>

      {make.takesReferences ? (
        <div className="gx-mk-refs" data-over={over} data-testid="gen-well"
          onDragOver={(e) => { if (isDroppable(e.dataTransfer)) { e.preventDefault(); setOver(true); } }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); make.dropOnWell(e.dataTransfer); }}>
          <div className="gx-mk-label">
            <span className="gx-mk-eyebrow">References</span>
            <span className="gx-mk-note">{make.references.length ? `${make.references.length} · ` : ""}drag from the Library or the board</span>
          </div>
          <div className="gx-mk-tiles">
            {make.references.map((r, i) => (
              <div className="gx-mk-tile" key={r.key} title={`${make.tags[i]} · ${r.name}`} data-testid="make-reference">
                {r.kind === "image" || r.kind === "video" ? <LazyMedia url={r.url} kind={r.kind} alt="" name={r.name} className="gx-lazy" />
                  : <svg viewBox="0 0 32 32" aria-hidden="true" className="gx-mk-wave"><path d="M7 14v4M11 10v12M15 6v20M19 11v10M23 8v16M27 13v6" /></svg>}
                <span className="gx-mk-tile-name">{r.name}</span>
                <button type="button" className="gx-mk-tile-x" aria-label={`Remove ${r.name}`} onClick={() => make.removeReference(r.key)}>×</button>
              </div>
            ))}
            <button type="button" className="gx-mk-add" onClick={() => shell.openLibrary("assets")} data-testid="make-add-reference">
              <span aria-hidden="true">+</span>Add
            </button>
          </div>
          {make.wellError ? <p className="gx-mk-error" role="alert">{make.wellError}</p> : null}
        </div>
      ) : null}

      <div className="gx-mk-engine" data-open={make.listOpen ? "" : undefined}>
        <div className="gx-mk-engine-row">
          <Glyph name="spark" size={16} className="gx-mk-spark" />
          <span className="gx-mk-line" data-testid="make-engine-line">
            {/* One line, as the phone writes it: "Seedance 2.5 · 1080p · 5 s · 43 cr". The separators are text, so it reads the same aloud and copied. */}
            {make.line.length ? make.line.map((part, i) => <span key={`${i}:${part}`} className="gx-mk-part">{i ? <span className="gx-mk-sep">{" · "}</span> : null}{part}</span>)
              : <span className="gx-mk-part">{make.readingModels ? "Reading the engines…" : "Choose an engine"}</span>}
            {make.linePrice ? <span className="gx-mk-part"><span className="gx-mk-sep">{" · "}</span><MakePriceText price={make.linePrice} testId="make-engine-price" /></span> : null}
          </span>
          <button type="button" className="gx-mk-change" aria-expanded={make.listOpen} aria-controls="gx-mk-engines"
            onClick={make.listOpen ? make.closeList : make.openList} data-testid="gen-model">{make.listOpen ? "Done" : "Change"}</button>
        </div>
        {make.listOpen ? <EngineList make={make} id="gx-mk-engines" scope={scope} /> : null}
      </div>

      {make.notices.map((n) => <p key={n} className="gx-mk-line-note" role="status">{n}</p>)}
      {make.result ? (
        <div className="gx-mk-result" role="alert" data-testid="make-result">
          <span className="gx-mk-eyebrow">Result</span>
          <p className="gx-mk-result-line">{make.result}</p>
          {/* Retry sends the same press again, at the figure on the button; whether anything was charged is not said here, only the ledger says that. */}
          {make.go.price && !make.go.blocked ? (
            <button type="button" className="gx-primary gx-mk-retry" data-spend="priced" data-spend-price={priceLabelOf(make.go.price) ?? undefined} onClick={make.go.press} data-testid="make-retry">
              Retry · <MakePriceText price={make.go.price} />
            </button>
          ) : null}
        </div>
      ) : null}
      {make.short ? (
        <p className="gx-mk-short" data-testid="make-short">
          {make.balance != null ? `Balance ${make.balance.toLocaleString("en-US")} cr · ${make.short.charAt(0).toLowerCase()}${make.short.slice(1)}` : make.short}
        </p>
      ) : null}
      <div className="gx-mk-go">
        <span className="gx-mk-dest" data-testid="make-dest">{make.dest}</span>
        {/* Short of credits: Top up is the button (a person asks for credits in Plan & credits; Make still waits, held, at its price). */}
        {make.short ? <button type="button" className="gx-primary gx-mk-go-btn" onClick={() => shell.goWorkspace("credits")} data-testid="make-top-up">Top up</button> : null}
        <button type="button" className={`${make.short || make.result ? "gx-hbtn" : "gx-primary"} gx-mk-go-btn`} aria-disabled={waits || undefined} data-waits={waits ? "" : undefined} data-spend={make.go.price ? "priced" : "unpriced"}
          aria-describedby={reason ? "gx-mk-reason" : undefined} title={(waits ? make.go.blocked : goTitle) ?? undefined} onClick={press} data-testid="gen-generate">
          <span>{make.go.action}</span>
          {make.go.price ? <><span className="gx-mk-go-sep"> · </span><MakePriceText price={make.go.price} /></> : null}
        </button>
      </div>
      {reason ? <p className="gx-mk-reason" id="gx-mk-reason" role="status" data-testid="gen-blocked">{reason}{reason === CHECK_LINE ? <> <CheckAgain className="gx-hbtn" /></> : null}</p> : null}

      <div className="gx-mk-tools" data-testid="make-quick-tools">
        <span className="gx-mk-eyebrow">Quick tools</span>
        {/* A row of destinations: each opens a tool, none starts a paid job (the tool's own button carries the price). */}
        <nav className="gx-mk-tools-row" aria-label="Quick tools">
          {QUICK_TOOLS.map(({ tool, glyph }) => (
            <button key={tool} type="button" className="gx-mk-tool" onClick={() => shell.setMake(tool)} data-testid={`make-tool-${tool}`}>
              <Glyph name={glyph} size={16} /><span>{tool === "upscale" ? UPSCALE_NAME : toolName(tool)}</span>
            </button>
          ))}
        </nav>
      </div>
    </section>
  );
}
