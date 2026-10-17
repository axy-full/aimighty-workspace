"use client";
import { createRef, useMemo, useRef, useState, type RefObject } from "react";
import type { SettingValue, Setup } from "@/lib/v12/board/board-data";
import { Popover } from "../ui/Popover";
import { SHOTS_SETTINGS, modelWords, valueWords, type PickedEngine, type Scope } from "./director-model";
import "./director.css";

/**
 * Director mode's settings column on Shots (v25 PR 7; design/particl-prototype-25 "Director · Shots": a slim column, its header and its button say the same
 * words as the scope pill). One row a setting: its name and its value; a press opens its pop-up beside it, a choice sets it, Esc or a click outside closes it.
 * The model is one line: the engine the person picked, or "None" until they pick one; Director never pre-selects an engine (owner, 16 Oct 2026, 2a). PR 9 opens
 * its pop-up.
 *
 * `values` are what the scope runs with; a setting the selected cards do not agree on reads "Mixed" and is set for all of them by a choice.
 * `onSet(id, value)` writes the step's setup when nothing is selected and every selected card's override when some are (the board's PR 4 data).
 * Nothing here is paid: a setting only changes what the next Render will ask the server to price.
 */
export function DirectorColumn({ scope, step, values, mixed, onSet, onHover, engine = null }: {
  scope: Scope;
  /** "Shots". */
  step: string;
  values: Setup;
  /** Setting ids the scope's cards disagree on. */
  mixed?: ReadonlySet<string>;
  onSet: (id: string, value: SettingValue) => void;
  /** The row under the pointer or focus, so the board can outline the cards that set it differently. */
  onHover?: (id: string | null) => void;
  /** The engine picked for the step; null (the default) until the person picks one. */
  engine?: PickedEngine | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const anchors = useMemo(() => new Map<string, RefObject<HTMLButtonElement | null>>(SHOTS_SETTINGS.map((item) => [item.id, createRef<HTMLButtonElement>()])), []);
  const item = SHOTS_SETTINGS.find((i) => i.id === open) ?? null;
  const rows = useRef<HTMLDivElement>(null);
  return (
    <aside className="v12-dircol" aria-label={`${step} settings`} data-testid="v12-director-column" ref={rows}>
      <div className="v12-dircol-head">
        <span className="v12-dircol-step">{step}</span>
        <span className="v12-dircol-scope" data-testid="v12-director-column-scope">{scope.label}</span>
      </div>
      <div className="v12-dircol-row v12-dircol-model" data-testid="v12-director-model" data-empty={engine ? undefined : ""}>
        <span className="v12-dircol-name">Model</span>
        <span className="v12-dircol-value">{modelWords(engine)}</span>
      </div>
      {SHOTS_SETTINGS.map((it) => (
        <button key={it.id} ref={anchors.get(it.id)} type="button" className="v12-dircol-row" data-setting={it.id} aria-haspopup="dialog" aria-expanded={open === it.id}
          data-testid={`v12-director-${it.id}`} onClick={() => setOpen(open === it.id ? null : it.id)}
          onMouseEnter={() => onHover?.(it.id)} onMouseLeave={() => onHover?.(null)} onFocus={() => onHover?.(it.id)} onBlur={() => onHover?.(null)}>
          <span className="v12-dircol-name">{it.label}</span>
          <span className="v12-dircol-value" data-mixed={mixed?.has(it.id) ? "" : undefined}>{mixed?.has(it.id) ? "Mixed" : valueWords(it, values[it.id])}</span>
        </button>
      ))}
      {item ? (
        <Popover open onClose={() => setOpen(null)} anchor={anchors.get(item.id)!} label={`${item.label} for ${scope.label}`} side="left" align="center" width={220} testId="v12-director-popup">
          <div className="v12-dirpop" role="radiogroup" aria-label={item.label}>
            <span className="v12-dirpop-head">{item.label} · {scope.label}</span>
            {item.choices.map((choice) => {
              const on = !mixed?.has(item.id) && values[item.id] === choice.value;
              return (
                <button key={String(choice.value)} type="button" role="radio" aria-checked={on} className="v12-dirpop-choice" data-testid="v12-director-choice"
                  onClick={() => { onSet(item.id, choice.value); setOpen(null); }}>{choice.label}</button>
              );
            })}
          </div>
        </Popover>
      ) : null}
    </aside>
  );
}
