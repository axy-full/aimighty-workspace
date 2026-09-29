"use client";
import { useState } from "react";
import { CREATIVE_CATEGORIES, DEFAULT_CREATIVE, type CreativeCategory, type MoleculrCreative } from "@/lib/workbench/moleculr-creative";
import { sendGenPreset } from "@/lib/shell/gen-preset";
import { sendReference } from "@/lib/shell/reference-inbox";
import { useShell } from "@/lib/shell/state";
import { useWorkspace } from "@/lib/workspace/state";
import { briefForGen, briefHooks, briefsIn, chooseProduct, chosenBrief, particlSetupItems, productLabel, withTemplate, type OwnPage } from "@/lib/shell/business-own";
import { CardHead, Field, SaveLine, briefOf, changeBrief, useLatest, type OwnEditor } from "./own-kit";

const ASPECTS: MoleculrCreative["aspect"][] = ["1:1", "4:5", "9:16", "16:9"];

/** A picker with nothing made yet: says so, with the page that makes it. */
function Missing({ text, action, onClick }: { text: string; action: string; onClick: () => void }) {
  return <div className="bo-inline"><span className="gx-hint">{text}</span><button type="button" className="gx-hbtn" onClick={onClick}>{action}</button></div>;
}

/**
 * Business › Format: Particl's eighteen original creative briefs across six
 * formats (lib/workbench/moleculr-creative.ts › CREATIVE_TEMPLATES), or a
 * direction in your own words, made with what Particl made in this project —
 * a saved product, the brand kit, a hook, the reference ad — and handed to
 * Gen: the brief's prompt, its frame and the product's stills. Nothing is
 * sent from here; Gen prices it on its button before anything runs.
 */
export function FormatTool({ editor, onOpen }: { editor: OwnEditor; onOpen: (page: OwnPage) => void }) {
  const p = editor.project!;
  const latest = useLatest(p);
  const shell = useShell();
  const { toast } = useWorkspace();
  const brief = briefOf(p);
  const creative = brief.creative ?? DEFAULT_CREATIVE;
  const [category, setCategory] = useState<CreativeCategory>(creative.category);
  const { template } = chosenBrief(brief);
  const made = particlSetupItems(p);
  const hooks = briefHooks(brief);
  const [hook, setHook] = useState<string | null>(null);
  const hookShown = hook && hooks.includes(hook) ? hook : null;
  const [problem, setProblem] = useState("");
  const kind = template?.kind ?? creative.kind ?? "image";
  const setCreative = (patch: Partial<MoleculrCreative>) => changeBrief(editor, (b) => ({ ...b, creative: { ...(b.creative ?? DEFAULT_CREATIVE), ...patch } }));

  const pickProduct = (id: string) => {
    const next = chooseProduct(briefOf(latest.current), id);
    if (!next.brief) { setProblem(next.problem); return; }
    changeBrief(editor, () => next.brief);
    setProblem("");
  };
  const handed = briefForGen(p, brief, hookShown);
  const open = () => {
    const ready = briefForGen(latest.current, briefOf(latest.current), hookShown);
    if ("problem" in ready) { setProblem(ready.problem); return; }
    void editor.ensureSaved();
    /* Words, kind and frame through Gen's one letterbox, the product's stills through its reference inbox (lib/shell). */
    sendGenPreset({ prompt: ready.prompt, type: ready.type, note: ready.note, billing: "workspace", picks: { ratio: ready.ratio } });
    for (const ref of ready.references) sendReference(ref);
    shell.goGen();
    toast(`${template ? template.name : "Your direction"} is in Gen. It is priced there before anything runs.`);
  };

  return (
    <div className="bo gx-enter" data-testid="format-tool">
      <section className="gx-gen-card" aria-label="Creative briefs" data-testid="format-briefs">
        <CardHead label="Start from" />
        <div className="gx-seg gx-seg--sm" role="tablist" aria-label="Start from">
          <button type="button" role="tab" className="gx-seg-btn" aria-selected={creative.path === "template"} onClick={() => setCreative({ path: "template" })} data-testid="format-path-briefs"><span>A creative brief</span></button>
          <button type="button" role="tab" className="gx-seg-btn" aria-selected={creative.path === "prompt"} onClick={() => setCreative({ path: "prompt", direction: creative.direction || template?.direction || "" })} data-testid="format-path-words"><span>Your own words</span></button>
        </div>
        {creative.path === "template" ? (<>
          <div className="gx-chips" role="group" aria-label="Formats" data-testid="format-categories">
            {CREATIVE_CATEGORIES.map((c) => <button key={c.id} type="button" className="gx-chip" aria-pressed={c.id === category} onClick={() => setCategory(c.id)}>{c.label}</button>)}
          </div>
          <p className="gx-hint">{CREATIVE_CATEGORIES.find((c) => c.id === category)?.description}</p>
          <div className="bo-briefs" role="group" aria-label={`${CREATIVE_CATEGORIES.find((c) => c.id === category)?.label} briefs`}>
            {briefsIn(category).map((t) => (
              <button key={t.id} type="button" className="bo-brief" aria-pressed={template?.id === t.id} aria-label={`Choose ${t.name}`} data-category={t.category}
                onClick={() => { changeBrief(editor, (b) => withTemplate(b, t)); setProblem(""); }} data-testid={`format-brief-${t.id}`}>
                <span className="bo-brief-face" aria-hidden="true"><span className="bo-brief-kind">{t.kind === "video" ? "Motion study" : "Composition study"}</span><span className="bo-brief-title">{t.name}</span></span>
                <span className="bo-brief-name">{t.name}</span>
                <span className="gx-hint">{t.description}</span>
                <span className="bo-brief-meta">{t.kind === "image" ? "Image" : "Video"} · {t.aspect}{t.beats.length ? ` · ${t.beats.length} beats` : ""}</span>
              </button>
            ))}
          </div>
          <p className="gx-hint">Particl’s own briefs — directions, not generated previews. Your engine makes them in Gen.</p>
        </>) : (<>
          <div className="bo-row">
            <span className="bo-field-label" data-functional-label="">Make</span>
            <div className="gx-chips" role="group" aria-label="Make" data-testid="format-kind">
              {(["image", "video"] as const).map((k) => <button key={k} type="button" className="gx-chip" aria-pressed={kind === k} onClick={() => setCreative({ kind: k })}>{k === "image" ? "An image" : "A video"}</button>)}
            </div>
          </div>
          <Field label="Your direction" hint="Composition, action, light and mood. Approved product facts ride with it.">
            <textarea className="gx-textarea" value={creative.direction} maxLength={6000} placeholder="Describe the frame or the film…" onChange={(e) => setCreative({ direction: e.target.value })} data-testid="format-words" />
          </Field>
        </>)}
      </section>

      {creative.path === "template" && template ? (
        <section className="gx-gen-card" aria-label={`Chosen · ${template.name}`} data-testid="format-chosen">
          <CardHead label={`Chosen · ${template.name}`}><span className="gx-hint">{template.kind === "image" ? "Image" : "Video"}</span></CardHead>
          <p className="bo-copy">{template.direction}</p>
          {template.beats.length ? (
            <ol className="bo-beats" data-testid="format-beats">
              {template.beats.map((beat, i) => <li key={i}><span className="bo-beat-head">{String(i + 1).padStart(2, "0")} · {beat.title} · {beat.seconds} s</span><span className="gx-hint">{beat.prompt}</span></li>)}
            </ol>
          ) : null}
          <Field label="Refinements for this campaign">
            <textarea className="gx-textarea bo-short" value={creative.direction} maxLength={6000} placeholder="What to keep, and what to make your own…" onChange={(e) => setCreative({ direction: e.target.value })} data-testid="format-refine" />
          </Field>
          {template.category === "posters" ? <div className="gx-gen-enhance"><button type="button" className="gx-hbtn" onClick={() => onOpen("design")}>Open Design for the type</button></div> : null}
        </section>
      ) : null}

      <section className="gx-gen-card" aria-label="Made with" data-testid="format-pickers">
        <CardHead label="Made with what Particl made" />
        <div className="bo-row" data-testid="format-product">
          <span className="bo-field-label" data-functional-label="">Product</span>
          {made.product.length ? (
            <div className="gx-chips" role="group" aria-label="Product">
              {(brief.products ?? []).map((profile) => <button key={profile.id} type="button" className="gx-chip" aria-pressed={profile.id === brief.activeProductId} onClick={() => pickProduct(profile.id)}>{productLabel(brief, profile)}</button>)}
            </div>
          ) : <Missing text={brief.productName.trim() ? `${brief.productName.trim()}, not saved as a profile yet.` : "No product yet."} action="Open Product" onClick={() => onOpen("product")} />}
        </div>
        <div className="bo-row" data-testid="format-brand">
          <span className="bo-field-label" data-functional-label="">Brand kit</span>
          {made.brand_kit[0] ? <p className="gx-hint"><span className="bo-strong">{made.brand_kit[0].name}</span> · {made.brand_kit[0].meta.replace(/^Made in Particl · /, "")}</p>
            : <Missing text="No brand kit yet." action="Open Brand" onClick={() => onOpen("brand")} />}
        </div>
        <div className="bo-row" data-testid="format-hook">
          <span className="bo-field-label" data-functional-label="">Hook</span>
          {hooks.length ? (
            <div className="gx-chips bo-hook-chips" role="group" aria-label="Hook">
              <button type="button" className="gx-chip" aria-pressed={!hookShown} onClick={() => setHook(null)}>None</button>
              {hooks.map((h) => <button key={h} type="button" className="gx-chip bo-chip-long" aria-pressed={hookShown === h} onClick={() => setHook(h)}>{h}</button>)}
            </div>
          ) : <Missing text="No hooks yet." action="Open Hooks" onClick={() => onOpen("hooks")} />}
        </div>
        {kind === "video" ? (
          <div className="bo-row" data-testid="format-reference">
            <span className="bo-field-label" data-functional-label="">Reference ad</span>
            {made.ad_reference[0] ? <p className="gx-hint"><span className="bo-strong">{made.ad_reference[0].name}</span>{brief.referenceAd?.direction.trim() ? " · its reviewed direction rides with the brief" : " · add a direction in Reference"}</p>
              : <Missing text="No reference ad." action="Open Reference" onClick={() => onOpen("reference")} />}
          </div>
        ) : null}
        <div className="bo-row" data-testid="format-aspect">
          <span className="bo-field-label" data-functional-label="">Frame</span>
          <div className="gx-chips" role="group" aria-label="Frame">
            {ASPECTS.map((a) => <button key={a} type="button" className="gx-chip" aria-pressed={creative.aspect === a} onClick={() => setCreative({ aspect: a })}>{a}</button>)}
          </div>
        </div>
      </section>

      <section className="gx-gen-card" aria-label="Make it" data-testid="format-make">
        <CardHead label="Make it in Gen" />
        {"problem" in handed ? <p className="gx-reason" data-testid="format-blocked">{handed.problem}</p> : (
          <p className="gx-hint" data-testid="format-summary">{handed.type === "video" ? "Video" : "Image"} · {handed.ratio} · {handed.references.length ? `${handed.references.length} product ${handed.references.length === 1 ? "still" : "stills"} as references` : "no product stills"} · {handed.prompt.length.toLocaleString("en-US")} characters of brief</p>
        )}
        <div className="gx-gen-enhance">
          <button type="button" className="gx-primary" disabled={"problem" in handed} onClick={open} data-testid="format-open-gen">Open in Gen</button>
          <span className="gx-hint">Gen shows the price on its button before anything runs.</span>
        </div>
        {problem ? <p className="gx-gen-error" role="alert" data-testid="format-error">{problem}</p> : null}
      </section>
      <SaveLine editor={editor} testId="format-save" />
    </div>
  );
}
