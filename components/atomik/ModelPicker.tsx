"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, X, Search, SlidersHorizontal, Sparkles } from "lucide-react";
import { Popover, Select } from "radix-ui";
import styles from "./ModelPicker.module.css";
import { displayModelName } from "@/lib/models";

export type EffortOption = { value: string; label: string; description?: string };
export type ThinkingModel = {
  id: string; name: string; vision?: boolean; efforts?: EffortOption[];
  description?: string; owner?: string; band?: string; released?: number;
};

const PROVIDERS = ["Claude", "Grok", "OpenAI", "Gemini"] as const;
const DEFAULT_EFFORT: EffortOption = { value: "auto", label: "Provider default", description: "Use this model’s standard reasoning settings." };

/** The model line a thinking model belongs to, which is also its group
 *  heading. Directly integrated, so named for real (lib/vendorNames.ts rule 1). */
function providerOf(model: ThinkingModel) {
  if (model.id.startsWith("anthropic/")) return "Claude";
  if (model.id.startsWith("openai/")) return "OpenAI";
  if (model.id.startsWith("google/")) return "Gemini";
  if (model.id.startsWith("spacexai/")) return "Grok";
  return "Other models";
}

export function thinkingModelName(id: string, models: ThinkingModel[] = []) {
  if (id === "auto") return "Auto";
  void models;
  return displayModelName(id);
}

export function effortLabel(value = "auto", model?: ThinkingModel) {
  return value === "auto" ? DEFAULT_EFFORT.label : model?.efforts?.find(option => option.value === value)?.label
    || (value.startsWith("budget:") ? `${Number(value.slice(7)).toLocaleString()} thinking tokens` : value.charAt(0).toUpperCase() + value.slice(1));
}

/** The same searchable, keyboard-operated library in the studio and legacy planning tools. */
export function ModelPicker({ value, models, onPick, disabled, label = "Thinking model", compact = false, id, allowAuto = true }: {
  value: string; models: ThinkingModel[]; onPick: (value: string) => void;
  disabled?: boolean; label?: string; compact?: boolean; id?: string; allowAuto?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("All");
  const [activeId, setActiveId] = useState(value);
  const search = useRef<HTMLInputElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const listId = useId();
  const uniqueModels = useMemo(() => [...new Map(models.map(model => [model.id, model])).values()], [models]);
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const visible = uniqueModels.filter(model => (provider === "All" || providerOf(model) === provider)
      && `${model.id} ${model.name} ${displayModelName(model.id)} ${providerOf(model)}`.toLowerCase().includes(needle));
    const names = [...new Set([...PROVIDERS, ...visible.map(providerOf)])];
    return names.map(name => ({ name, models: visible.filter(model => providerOf(model) === name).sort((a, b) => (b.released ?? 0) - (a.released ?? 0) || thinkingModelName(a.id, uniqueModels).localeCompare(thinkingModelName(b.id, uniqueModels), undefined, { numeric: true })) })).filter(group => group.models.length);
  }, [query, provider, uniqueModels]);
  const autoVisible = allowAuto && provider === "All" && (!query.trim() || "auto automatic economy".includes(query.trim().toLowerCase()));
  const options = [...(autoVisible ? ["auto"] : []), ...groups.flatMap(group => group.models.map(model => model.id))];
  const active = options.includes(activeId) ? activeId : options[0];
  const activeIndex = options.indexOf(active);
  const current = uniqueModels.find(model => model.id === value);
  const name = thinkingModelName(value, uniqueModels);
  const selectedProvider = current ? providerOf(current) : undefined;

  useEffect(() => { if (open && active) rows.current.get(active)?.scrollIntoView({ block: "nearest" }); }, [open, active]);

  function pick(next: string) { onPick(next); setOpen(false); }
  function row(model: ThinkingModel) {
    const selected = model.id === value;
    return <div key={model.id} id={`${listId}-${options.indexOf(model.id)}`} role="option" aria-selected={selected}
      aria-label={thinkingModelName(model.id, uniqueModels)} tabIndex={-1}
      ref={element => { if (element) rows.current.set(model.id, element); else rows.current.delete(model.id); }}
      className={styles.option} data-active={active === model.id} data-selected={selected}
      onPointerMove={() => setActiveId(model.id)} onMouseDown={event => event.preventDefault()} onClick={() => pick(model.id)}>
      <span className={styles.optionText}>
        <span className={styles.modelName}>{thinkingModelName(model.id, uniqueModels)}</span>
        <span className={styles.capabilities}>{[model.vision ? "Vision" : "Text", model.efforts?.some(option => option.value !== "auto") ? "Adjustable effort" : "Standard reasoning", model.band].filter(Boolean).join(" · ")}</span>
      </span>
      {selected && <Check size={15} aria-hidden="true" className={styles.check} />}
    </div>;
  }

  return <Popover.Root open={open && !disabled} onOpenChange={next => {
    setOpen(next); if (next) { setQuery(""); setProvider("All"); setActiveId(value); }
  }}>
    <Popover.Trigger asChild>
      <button type="button" id={id} aria-label={label} title={`${label}: ${name}`} disabled={disabled}
        className={`${styles.trigger} ${compact ? styles.compact : ""}`}>
        {selectedProvider ? <span className={styles.providerMark} aria-hidden="true">{selectedProvider.charAt(0)}</span> : <Sparkles size={14} aria-hidden="true" />}
        <span className={styles.triggerName}>{name}</span><ChevronDown size={13} aria-hidden="true" />
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className={styles.popup} aria-label="Choose a thinking model" sideOffset={8} align="end" collisionPadding={12}
        onOpenAutoFocus={event => { event.preventDefault(); search.current?.focus(); }}
        onEscapeKeyDown={event => event.stopPropagation()}>
        <div className={styles.heading}><span>Thinking model</span><span>{uniqueModels.length} available</span><Popover.Close className={`hidden ${styles.mobileClose}`} aria-label="Close model picker"><X size={20}/></Popover.Close></div>
        <div className={styles.search}>
          <Search size={16} aria-hidden="true" />
          <input ref={search} value={query} type="search" autoComplete="off" placeholder="Search models…" aria-label="Search thinking models"
            role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={listId}
            aria-activedescendant={active ? `${listId}-${activeIndex}` : undefined}
            onChange={event => { setQuery(event.target.value); setActiveId(""); }}
            onKeyDown={event => {
              if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length) {
                event.preventDefault(); event.stopPropagation();
                setActiveId(options[(activeIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]);
              } else if (event.key === "Enter") {
                event.preventDefault(); event.stopPropagation(); if (active) pick(active);
              }
            }} />
          <span className={styles.escape} aria-hidden="true">esc</span>
        </div>
        <div className={styles.providers} role="group" aria-label="Filter thinking models by family">
          {["All", ...PROVIDERS.filter(name => uniqueModels.some(model => providerOf(model) === name))].map(name => <button type="button" key={name} aria-pressed={provider === name}
            onClick={() => { setProvider(name); setActiveId(""); search.current?.focus(); }}>{name}</button>)}
        </div>
        <div className={styles.list} role="listbox" aria-label="Thinking models" id={listId}>
          {autoVisible && <div id={`${listId}-0`} role="option" aria-label="Auto" aria-selected={value === "auto"}
            className={`${styles.option} ${styles.auto}`} data-active={active === "auto"} data-selected={value === "auto"} tabIndex={-1}
            ref={element => { if (element) rows.current.set("auto", element); else rows.current.delete("auto"); }}
            onPointerMove={() => setActiveId("auto")} onMouseDown={event => event.preventDefault()} onClick={() => pick("auto")}>
            <Sparkles size={17} aria-hidden="true" />
            <span className={styles.optionText}><span className={styles.modelName}>Auto <span className={styles.autoBadge}>Economy</span></span><span className={styles.capabilities}>Select a compatible model for this request</span></span>
            {value === "auto" && <Check size={15} aria-hidden="true" className={styles.check} />}
          </div>}
          {groups.map(group => <div role="group" aria-label={group.name} key={group.name}>
            <div className={styles.groupHeading}><span>{group.name}</span><span>{group.models.length}</span></div>
            {group.models.map(row)}
          </div>)}
          {!options.length && <div className={styles.empty}>No models found.<span>Try a model name or another family.</span></div>}
        </div>
        <div className={styles.footer}>Model and effort are included in your estimate.</div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

export function EffortPicker({ value, model, onPick, disabled, label = "Reasoning effort", compact = false, id }: {
  value: string; model?: ThinkingModel; onPick: (value: string) => void;
  disabled?: boolean; label?: string; compact?: boolean; id?: string;
}) {
  const options = [DEFAULT_EFFORT, ...(model?.efforts ?? []).filter(option => option.value !== "auto")];
  const adjustable = !!model && options.length > 1;
  const unavailable = !options.some(option => option.value === value);
  const note = !model ? "Choose a model to set its reasoning effort." : !adjustable ? "This model uses provider default reasoning."
    : options.find(option => option.value === value)?.description || "More reasoning can increase time and cost.";
  const descriptionId = useId();
  return <div className={styles.effort}>
    <Select.Root value={value} onValueChange={onPick} disabled={disabled || !adjustable}>
      <Select.Trigger id={id} aria-label={label} aria-describedby={compact ? undefined : descriptionId} title={`${label}: ${effortLabel(value, model)}. ${note}`}
        className={`${styles.trigger} ${compact ? styles.compact : ""}`}>
        <SlidersHorizontal size={14} aria-hidden="true" /><span className={styles.triggerName}><Select.Value>{value === "auto" && compact ? "Effort: Auto" : effortLabel(value, model)}</Select.Value></span>
        <Select.Icon><ChevronDown size={13} aria-hidden="true" /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className={`${styles.popup} ${styles.effortPopup}`} position="popper" sideOffset={8} align="end" collisionPadding={12}
          onEscapeKeyDown={event => event.stopPropagation()}>
          <div className={styles.heading}>Reasoning effort</div>
          <Select.Viewport className={styles.effortList}>
            {options.map(option => <Select.Item key={option.value} value={option.value} className={styles.effortOption}>
              <span className={styles.effortText}><span className={styles.effortLabel}><Select.ItemText>{option.label}</Select.ItemText></span>{option.description && <span className={styles.capabilities}>{option.description}</span>}</span>
              <Select.ItemIndicator className={styles.check}><Check size={15} aria-hidden="true" /></Select.ItemIndicator>
            </Select.Item>)}
            {unavailable && <Select.Item value={value} disabled className={styles.effortOption}><Select.ItemText>{effortLabel(value, model)} · saved request</Select.ItemText></Select.Item>}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
    {!compact && <p id={descriptionId} className={styles.effortNote}>{note}</p>}
  </div>;
}
