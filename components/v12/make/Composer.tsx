"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMake, type MakeInput } from "@/components/graphite/make/use-make";
import { useShell } from "@/lib/shell/state";
import { spendAttrsOf, spendAttrsText } from "@/lib/spend";
import { TAKES_MAX } from "@/lib/workspace/composer";
import { knownQuote } from "@/lib/v12/quote";
import { EDIT_OPS, MAKE_MODES, REMIX_OPS, modeType, placeholderFor, type MakeMode, type MakeOp, type ResultTile } from "@/lib/v12/make";
import { Bar, BarChip, type BarMention } from "@/components/v12/bar/Bar";
import { Price } from "@/components/v12/ui/Price";
import { Menu, type MenuItem } from "@/components/v12/ui/Popover";
import { Segment } from "@/components/v12/ui/Segment";

const TYPE_WORD = { image: "a still", video: "a clip", audio: "a sound" } as const;
/** Counts offered for stills (the prototype's "1 · 2 · 4"), within the composer's limit. */
const COUNTS = [1, 2, 4].filter((n) => n <= TAKES_MAX);

/** A setting chip: "Model Nano Banana 2 ▾", with its menu. */
function Chip({ k, v, title, items, onOpen, onClose, testId }: { k: string; v: string; title: string; items: readonly MenuItem[]; onOpen?: () => void; onClose?: () => void; testId: string }) {
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
export function Composer({ input, asked, mentions }: {
  /** Today's Make inputs (use-make.ts); Make is a page here, so a press that went through keeps it open. */
  input: Omit<MakeInput, "keepOpen" | "onBoard">;
  /** The mode the address asked for when the page opened (`mk=`). */
  asked: MakeMode | null;
  /** The workspace's own stills and clips, to pull in as references with @. */
  mentions: readonly ResultTile[];
}) {
  const shell = useShell();
  const make = useMake({ ...input, onBoard: false, keepOpen: true });
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
  const onMode = useCallback((next: MakeMode) => {
    if (next === "remix" || next === "edit") { setExtra({ mode: next, recipe: recipeName }); return; }
    setExtra(null);
    const type = modeType(next);
    if (type) pickType(type); else unpick();
  }, [pickType, unpick, recipeName]);
  const { state, model, settings, composer } = make;
  const ops = mode === "remix" ? REMIX_OPS : mode === "edit" ? EDIT_OPS : null;
  const runOp = (op: MakeOp) => { if (op.tool) shell.openMake(op.tool); };

  /* The settings chips, for what the engine offers. */
  const chips: { k: string; v: string; title: string; items: MenuItem[]; onOpen?: () => void; onClose?: () => void; testId: string }[] = [];
  if (!ops && model) {
    chips.push({
      k: "Model", v: model.label, title: "Engines from the rate card", testId: "v12-make-chip-model", onOpen: make.openList, onClose: make.closeList,
      items: make.offered.map((m) => {
        const row = make.rowValue(m);
        return { id: m.id, label: m.label, onSelect: () => make.pickEngine(m), hint: row.value ? <Price quote={knownQuote(row.value)} /> : row.about ?? undefined };
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
  const priceNode = price?.value ? <Price quote={knownQuote(price.value)} testId="v12-make-price" /> : price?.about ? <span className="v12-price" data-price="about" data-testid="v12-make-price">{price.about}</span> : undefined;
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
  const note = make.wellError ? { tone: "problem" as const, text: make.wellError }
    : make.result ? { tone: "problem" as const, text: make.result }
      : make.short ? { tone: "problem" as const, text: make.short }
        : make.notices[0] ? { tone: "note" as const, text: make.notices[0] }
          : make.spendOff ? { tone: "note" as const, text: make.spendOff } : null;
  const blocked = ops ? "Pick one of the four first" : make.go.blocked;

  const head = (
    <div className="v12-mk-head" data-testid="v12-make-head">
      <Segment label="What to make" size="md" value={mode} onChange={onMode}
        options={MAKE_MODES.map((m) => ({ id: m.id, label: m.label }))} />
      {autoLine ? (
        <span className="v12-mk-auto" data-testid="v12-make-auto"><span className="v12-mk-dot" aria-hidden="true" />{autoLine[0]}{priceNode ? <> · {priceNode}</> : null} · override by picking a mode</span>
      ) : null}
      {ops ? (
        <span className="v12-mk-ops" role="group" aria-label={mode === "remix" ? "Remix" : "Edit"} data-testid="v12-make-ops">
          {mode === "remix" ? <span className="v12-mk-quiet">{make.references[0]?.name ?? "Your source"} · what do we do with it?</span> : null}
          {ops.map((op) => (
            <button key={op.id} type="button" className="v12-mk-op" disabled={!op.tool} onClick={() => runOp(op)}
              title={op.tool ? `${op.label} — opens the tool, which shows its price` : op.why ?? undefined} data-testid="v12-make-op" data-op={op.id}>{op.label}</button>
          ))}
        </span>
      ) : null}
      <span className="v12-mk-grow" />
      {chips.map((c) => <Chip key={c.k} {...c} />)}
    </div>
  );
  const refs = make.references.length ? (
    <div className="v12-mk-refs" data-testid="v12-make-refs">
      <span className="v12-mk-quiet">References</span>
      {make.references.map((r) => (
        <BarChip key={r.key} tone="picked" thumb={r.url ?? null} media={r.kind === "video" ? "video" : "image"} label={r.name} onRemove={() => make.removeReference(r.key)} testId="v12-make-ref" />
      ))}
    </div>
  ) : null;

  return (
    <div className="v12-mk-composer" data-testid="v12-make-composer" data-mode={mode}>
      <Bar
        docked
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
        onMention={(m) => void make.addReference(`generation:${m.id}`)}
        note={note}
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
