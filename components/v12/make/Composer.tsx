"use client";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMake, type MakeInput } from "@/components/graphite/make/use-make";
import { useShell } from "@/lib/shell/state";
import { spendAttrsOf, spendAttrsText } from "@/lib/spend";
import { TAKES_MAX } from "@/lib/workspace/composer";
import { useSession } from "@/lib/session";
import { creditRate } from "@/lib/shell/price-words";
import { EnhanceButton } from "./EnhanceButton";
import { ENHANCE_AGAIN, ENHANCE_HINT, ENHANCE_PROGRESS_MS, ENHANCE_UNDO, ENHANCE_WORKING, changedWords, enhanceOffered, workspaceEnhance } from "@/lib/v12/enhance";
import { LOADING } from "@/lib/v12/quote";
import { exact } from "@/lib/shell/price-words";
import { useRead } from "@/components/graphite/settings/use-settings";
import { EDIT_OPS, MAKE_MODES, REMIX_NEEDS_SOURCE, REMIX_OPS, houseAbout, makeQuote, modeType, placeholderFor, type MakeMode, type MakeOp, type ResultTile } from "@/lib/v12/make";
import { Bar, BarChip, type BarMention } from "@/components/v12/bar/Bar";
import { useBarSkills } from "@/components/v12/bar/use-bar-skills";
import { Price } from "@/components/v12/ui/Price";
import { Menu, type MenuItem } from "@/components/v12/ui/Popover";
import { Segment } from "@/components/v12/ui/Segment";

const TYPE_WORD = { image: "a still", video: "a clip", audio: "a sound" } as const;
/** Counts offered for stills (the prototype's "1 · 2 · 4"), within the composer's limit. */
const COUNTS = [1, 2, 4].filter((n) => n <= TAKES_MAX);

/** A setting chip: "Model Nano Banana 2 ▾", with its menu. */
function Chip({ k, v, title, items, onOpen, onClose, testId }: { k: string; v: ReactNode; title: string; items: readonly MenuItem[]; onOpen?: () => void; onClose?: () => void; testId: string }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => { setOpen(false); onClose?.(); };
  return (
    <>
      <button ref={anchor} type="button" className="v12-mk-chip" title={title} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { if (open) close(); else { setOpen(true); onOpen?.(); } }} data-testid={testId}>
        <span className="v12-mk-chip-k">{k}</span>{v}<span className="v12-mk-chip-caret" aria-hidden="true">▾</span>
      </button>
      <Menu open={open} onClose={close} anchor={anchor} label={k} items={items} side="top" width={280} />
    </>
  );
}

/**
 * Make's docked composer (docs/redesign/inventory.md § 5.12): the shared bar (components/v12/bar) with the modes (Auto ·
 * Image · Video · Audio · Remix · Edit), Auto's one line, the setting chips, the references, and "Make · N cr". It draws
 * today's Make logic (components/graphite/make/use-make.ts) unchanged: the words, type, engine and settings, the live
 * quote the server gives for exactly what will be sent, and the one priced send. Remix and Edit open today's quick
 * tools, which price themselves; the rest say why they are not here yet.
 */
export function Composer({ input, asked, mentions, onClearSeed }: {
  /** Today's Make inputs (use-make.ts); Make is a page here, so a press that went through keeps it open. */
  input: Omit<MakeInput, "keepOpen" | "onBoard">;
  /** The mode the address asked for when the page opened (`mk=`). */
  asked: MakeMode | null;
  /** The workspace's own stills and clips, to pull in as references with @. */
  mentions: readonly ResultTile[];
  /** Drops the seed the viewer set (its chip's ×). */
  onClearSeed?: () => void;
}) {
  const shell = useShell();
  const session = useSession();
  /* Prices in the workspace's own unit: credits, or dollars for the workspace that pays in dollars. */
  const money = { dollars: session.rates.unit === "usd", creditUsd: creditRate(session.rates.creditUsd) };
  /* An approximate price in words (Cinema Studio): credits for a credit workspace; for the house the engine's dollars, or no figure when it has none (never the customer price). */
  const aboutOf = (p: { about: string | null; usd?: number | null }) => (!money.dollars ? p.about : typeof p.usd === "number" ? houseAbout(p.usd) : "—");
  /* Enhance (lib/v12/enhance.ts): a button, pressed by the person. It puts the enhanced words in the box and generates nothing; Make sends the box as written.
     The workspace's setting (Settings › Advanced) says whether Make offers it; On unless an admin turned it off. The house, which pays in dollars at cost, has it too:
     its enhancement is priced in the text model's own dollars. */
  const defaults = useRead<{ settings: Record<string, string> }>("/api/settings");
  const make = useMake({ ...input, onBoard: false, keepOpen: true, labelTakes: true });
  const { enhancer } = make;
  const offered = workspaceEnhance(defaults.data?.settings.enhanceDefault);
  /* Shown only once the workspace's setting is known (or that it could not be read, which is On). */
  const enhanceKnown = defaults.data !== null || defaults.error !== null;
  const enhanceShown = enhanceKnown && offered && !make.spendOff && Boolean(make.model) && enhanceOffered(make.state.type);
  /* The mode: Remix or Edit when picked here, else the composer's own type once picked, else Auto. */
  const { pickType, unpick, recipe } = make;
  /* A recipe that lands (prompt reuse) is made in its own type: Remix or Edit, picked before it, gives way to it. */
  const recipeName = recipe?.name ?? null;
  const [extraAt, setExtra] = useState<{ mode: "remix" | "edit"; recipe: string | null } | null>(asked === "remix" || asked === "edit" ? { mode: asked, recipe: null } : null);
  const extra = extraAt && extraAt.recipe === recipeName ? extraAt.mode : null;
  useEffect(() => {
    const type = asked ? modeType(asked) : null;
    if (type) pickType(type);
    else if (asked === "auto") unpick();
  }, [asked, pickType, unpick]);
  const mode: MakeMode = extra ?? (make.picked ? make.state.type : "auto");
  const [sourceAsked, setSourceAsked] = useState(false);
  const onMode = useCallback((next: MakeMode) => {
    setSourceAsked(false);
    if (next === "remix" || next === "edit") { setExtra({ mode: next, recipe: recipeName }); return; }
    setExtra(null);
    const type = modeType(next);
    if (type) pickType(type); else unpick();
  }, [pickType, unpick, recipeName]);
  const { state, model, settings, composer } = make;
  const ops = mode === "remix" ? REMIX_OPS : mode === "edit" ? EDIT_OPS : null;
  /* Remix works on a source: with none in the composer an op says so, and opens nothing. */
  const hasSource = make.references.some((r) => r.kind === "video");
  const sourceNote = sourceAsked && mode === "remix" && !hasSource;
  const runOp = (op: MakeOp) => {
    if (!op.tool) return;
    if (mode === "remix" && !hasSource) { setSourceAsked(true); return; }
    shell.openMake(op.tool);
  };

  /* The settings chips, for what the engine offers. */
  const chips: { k: string; v: ReactNode; title: string; items: MenuItem[]; onOpen?: () => void; onClose?: () => void; testId: string }[] = [];
  if (!ops && model) {
    chips.push({
      /* "Nano Banana 2 · 2K · 2 cr": the engine, its size and one take's price, the server's. */
      k: "Model", v: <>{model.label}{settings.resolution && state.type !== "audio" ? ` · ${settings.resolution}` : ""}{make.linePrice?.value ? <> · <Price quote={makeQuote(make.linePrice.value, money, make.linePrice.usd)} testId="v12-make-chip-price" /></> : make.linePrice?.about ? ` · ${aboutOf(make.linePrice)}` : null}</>,
      title: "Engines from the rate card", testId: "v12-make-chip-model", onOpen: make.openList, onClose: make.closeList,
      items: make.offered.map((m) => {
        const row = make.rowValue(m);
        return { id: m.id, label: m.label, onSelect: () => make.pickEngine(m), hint: row.value ? <Price quote={makeQuote(row.value, money, row.usd)} /> : row.about ? aboutOf(row) : undefined };
      }),
    });
    const ratios = (model.ratios ?? []).filter((r) => r !== "adaptive");
    if (state.type !== "audio" && ratios.length > 1)
      chips.push({ k: "Aspect", v: settings.ratio, title: ratios.join(" · "), testId: "v12-make-chip-aspect",
        items: ratios.map((r) => ({ id: r, label: r, onSelect: () => make.composer.dispatch({ type: "pick", value: { ratio: r } }) })) });
    const lengths = model.durations ?? [];
    if (state.type === "video" && lengths.length > 1)
      chips.push({ k: "Length", v: `${settings.duration} s`, title: lengths.map((d) => `${d} s`).join(" · "), testId: "v12-make-chip-length",
        items: lengths.map((d) => ({ id: String(d), label: `${d} s`, onSelect: () => make.composer.dispatch({ type: "pick", value: { duration: d } }) })) });
    if (state.type === "image" && !settings.draft)
      chips.push({ k: "Count", v: String(state.count), title: COUNTS.join(" · "), testId: "v12-make-chip-count",
        items: COUNTS.map((n) => ({ id: String(n), label: String(n), onSelect: () => make.composer.dispatch({ type: "count", value: n }) })) });
  }

  const price = make.go.price;
  const priceNode = price?.value ? <Price quote={makeQuote(price.value, money, price.usd)} testId="v12-make-price" /> : price?.about ? <span className="v12-price" data-price="about" data-testid="v12-make-price">{aboutOf(price)}</span> : undefined;
  const attrs = price?.value ? spendAttrsOf(price.value) : price?.about ? spendAttrsText(price.about) : { "data-spend": "unpriced" as const };
  const autoLine = mode === "auto" && model
    ? [`Auto · ${TYPE_WORD[state.type]}, so ${model.label}${settings.resolution && state.type !== "audio" ? ` at ${settings.resolution}` : ""}`]
    : null;
  const mentionList: BarMention[] = mentions.filter((t) => t.url && t.kind !== "audio").slice(0, 12)
    .map((t) => ({ id: t.id, name: t.prompt.length > 48 ? `${t.prompt.slice(0, 47)}…` : t.prompt, kind: t.type, thumb: t.url, media: t.kind === "video" ? "video" : "image" }));
  const attach = (files: File[]) => {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    make.dropOnWell(dt);
  };
  const note = sourceNote ? { tone: "note" as const, text: REMIX_NEEDS_SOURCE }
    : make.wellError ? { tone: "problem" as const, text: make.wellError }
    : enhanceShown && make.enhanceState.phase !== "idle" ? { tone: "note" as const, text: make.enhanceState.hint ? ENHANCE_HINT : ENHANCE_WORKING, action: { label: "Cancel", onPress: make.enhanceState.cancel, testId: "v12-make-enhance-cancel" } }
    : enhanceShown && enhancer.error ? { tone: "problem" as const, text: enhancer.error, action: { label: ENHANCE_AGAIN, onPress: () => void make.pressEnhance(), testId: "v12-make-enhance-again" } }
    : make.result ? { tone: "problem" as const, text: make.result }
      : make.short ? { tone: "problem" as const, text: make.short }
        : enhanceShown && make.enhanced ? { tone: "note" as const, text: <>Enhanced · <Price quote={makeQuote(exact(make.enhanced.credits), money, make.enhanced.usd)} testId="v12-make-enhanced-price" /></>, action: { label: ENHANCE_UNDO, onPress: make.undoEnhance, testId: "v12-make-enhance-undo" } }
        : make.notices[0] ? { tone: "note" as const, text: make.notices[0] }
          : make.spendOff ? { tone: "note" as const, text: make.spendOff }
            : null;
  const blocked = ops ? "Pick one of the four first" : make.go.blocked;
  /* Enhance wears its quote before it is pressed (a read, free): "Enhance · 1 cr"; unread, "…"; unreadable, a dash with the reason on hover. */
  const words = state.prompt.trim().length > 0;
  const enhanceQuote = enhancer.credits != null ? makeQuote(exact(enhancer.credits), money, enhancer.usd)
    : enhancer.unavailable ? { state: "error" as const, message: enhancer.unavailable }
      : words && !enhancer.blocked?.startsWith("raw:") ? LOADING : null;
  const working = enhanceShown && make.enhanceState.phase !== "idle";
  const marks = make.enhanceState.marked ? changedWords(make.enhanceState.marked.original, make.enhanceState.marked.enhanced) : null;
  /* What a screen reader is told as the press goes (a polite live region; the button and the box carry aria-busy). */
  const announce = working ? (make.enhanceState.hint ? ENHANCE_HINT : ENHANCE_WORKING)
    : enhancer.error ? enhancer.error
      : make.enhanced ? `Enhanced. ${ENHANCE_UNDO} is available.` : "";
  const enhanceButton = (
    <EnhanceButton busy={enhancer.busy} disabled={Boolean(enhancer.blocked) || make.submitting} why={enhancer.blocked}
      price={enhanceQuote ? <Price quote={enhanceQuote} testId="v12-make-enhance-price" /> : null}
      attrs={enhancer.credits != null ? spendAttrsOf(exact(enhancer.credits)) : { "data-spend": "unpriced" }}
      onPress={() => void make.pressEnhance()} />
  );

  const head = (
    <div className="v12-mk-head" data-testid="v12-make-head">
      <Segment label="What to make" size="md" value={mode} onChange={onMode}
        options={MAKE_MODES.map((m) => ({ id: m.id, label: m.label }))} />
      {autoLine ? (
        <span className="v12-mk-auto" data-testid="v12-make-auto"><span className="v12-mk-dot" aria-hidden="true" />{autoLine[0]}{priceNode ? <> · {priceNode}</> : null}</span>
      ) : null}
      {ops ? (
        <span className="v12-mk-ops" role="group" aria-label={mode === "remix" ? "Remix" : "Edit"} data-testid="v12-make-ops">
          {mode === "remix" ? <span className="v12-mk-quiet">{make.references[0]?.name ?? "Your source"} · what do we do with it?</span> : null}
          {/* aria-disabled, not disabled: a disabled button gets no hover in some browsers, and the price's reason is on that hover. */}
          {ops.map((op) => (
            <button key={op.id} type="button" className="v12-mk-op" aria-disabled={!op.tool || undefined} onClick={() => runOp(op)}
              title={op.tool ? `${op.label} — opens the tool, which shows its price` : op.why ?? undefined} data-testid="v12-make-op" data-op={op.id}>
              {op.label}{op.reason ? <> · <Price quote={null} reason={op.reason} /></> : null}
            </button>
          ))}
          {mode === "remix" ? (
            <button type="button" className="v12-mk-op" onClick={() => shell.openAtomik("panel", "What should we do with this video: ")} data-testid="v12-make-remix-ask">Ask Atomik</button>
          ) : null}
        </span>
      ) : null}
      <span className="v12-mk-grow" />
      {enhanceShown && !ops ? enhanceButton : null}
      {chips.map((c) => <Chip key={c.k} {...c} />)}
    </div>
  );
  /* The seed the next clip repeats, while the engine it was made on is picked (lib/workspace/use-composer `seed`). */
  const seed = make.composer.seed;
  /* Picking another engine drops the seed (it belongs to the engine it was made on). The engine the viewer loads arrives a moment
     after the seed does, so it is dropped only after that engine has been the one picked. */
  const seedFor = input.seed ?? null;
  const seedMatched = useRef(false);
  useEffect(() => { seedMatched.current = false; }, [seedFor?.value, seedFor?.model]);
  useEffect(() => {
    if (!seedFor || !model) return;
    if (model.id === seedFor.model) seedMatched.current = true;
    else if (seedMatched.current) onClearSeed?.();
  }, [seedFor, model, onClearSeed]);
  const seedChip = seed !== null ? (
    <BarChip label={`Seed ${seed}`} onRemove={onClearSeed} removeTitle="Stop repeating this seed" testId="v12-make-seed" />
  ) : null;
  const refs = make.references.length || seedChip ? (
    <div className="v12-mk-refs" data-testid="v12-make-refs">
      {seedChip}
      {make.references.length ? <span className="v12-mk-quiet">References</span> : null}
      {make.references.map((r) => (
        <BarChip key={r.key} tone="picked" thumb={r.url ?? null} media={r.kind === "video" ? "video" : "image"} label={r.name} onRemove={() => make.removeReference(r.key)} testId="v12-make-ref" />
      ))}
    </div>
  ) : null;

  const skills = useBarSkills(state.prompt, make.setPrompt);
  return (
    <div className="v12-mk-composer" data-testid="v12-make-composer" data-mode={mode} style={{ "--v12-enhance-wait": `${ENHANCE_PROGRESS_MS}ms` } as CSSProperties}>
      <span className="v12-sr" role="status" aria-live="polite" data-testid="v12-make-enhance-live">{announce}</span>
      <Bar
        docked
        skills={skills}
        value={state.prompt}
        onChange={make.setPrompt}
        onSubmit={() => make.go.press()}
        placeholder={placeholderFor(mode, { engine: state.type === "video" ? model?.label ?? null : null, seconds: settings.duration ?? null })}
        label="Describe it"
        sheet={<>{head}{refs}</>}
        onAttach={make.takesReferences ? attach : undefined}
        attachAccept="image/*,video/*"
        mentions={make.takesReferences ? mentionList : undefined}
        mentionsTitle="From your results"
        onMention={make.takesReferences ? (m) => void make.addReference(/^(upload|generation):/.test(m.id) ? m.id : `generation:${m.id}`) : undefined}
        note={note}
        working={working}
        onCancel={make.enhanceState.cancel}
        marked={marks ? <>{marks.map((m, i) => (m.changed ? <mark key={i}>{m.text}</mark> : <span key={i}>{m.text}</span>))}</> : null}
        send={{
          label: ops ? "Pick what to do" : composer.buttonParts.action || "Make",
          price: ops ? undefined : priceNode,
          disabled: Boolean(blocked) || (!ops && !price),
          busy: make.submitting,
          busyLabel: "Making…",
          title: blocked ?? undefined,
          testId: "v12-make-go",
          variant: ops ? "quiet" : "filled",
          attrs: ops ? {} : attrs,
        }}
        testId="v12-make-bar"
      />
    </div>
  );
}
