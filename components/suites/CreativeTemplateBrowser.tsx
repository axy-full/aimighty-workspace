"use client";

import { useState } from "react";
import { ArrowUpRight, Check, Layers } from "lucide-react";
import {
  CREATIVE_CATEGORIES,
  CREATIVE_TEMPLATES,
  DEFAULT_CREATIVE,
  creativeTemplate,
  type CreativeCategory,
} from "@/lib/workbench/moleculr-creative";
import type { MoleculrBrief } from "@/lib/workbench/moleculr";
import styles from "./moleculr-creative.module.css";

export function CreativeTemplateBrowser({
  brief,
  enabled,
  onChange,
  onKind,
  onBuildStoryboard,
  onDesign,
}: {
  brief: MoleculrBrief;
  enabled: boolean;
  onChange: (brief: MoleculrBrief) => void;
  onKind: (kind: "image" | "video") => void;
  onBuildStoryboard?: () => void;
  onDesign: () => void;
}) {
  const creative = brief.creative ?? DEFAULT_CREATIVE;
  const [category, setCategory] = useState<CreativeCategory>(creative.category);
  const selected = creativeTemplate(brief);
  const categories = CREATIVE_CATEGORIES.find((item) => item.id === category)!;
  return (
    <section className="suite-panel" aria-label="Creative templates">
      <div className="suite-section-heading">
        <div>
          <h2>Start with an expression.</h2>
          <p>
            Choose a creative brief, or direct the campaign in your own words.
          </p>
        </div>
        <span className="suite-badge">Moleculr originals</span>
      </div>
      <div className={styles.paths} role="group" aria-label="Creative path">
        <button
          disabled={!enabled}
          aria-pressed={creative.path === "template"}
          onClick={() =>
            onChange({ ...brief, creative: { ...creative, path: "template" } })
          }
        >
          Browse creative templates
        </button>
        <button
          disabled={!enabled}
          aria-pressed={creative.path === "prompt"}
          onClick={() =>
            onChange({
              ...brief,
              creative: {
                ...creative,
                path: "prompt",
                direction: creative.direction || selected?.direction || "",
              },
            })
          }
        >
          Write a prompt
        </button>
      </div>
      {creative.path === "template" ? (
        <>
          <div
            className={styles.categories}
            role="group"
            aria-label="Creative categories"
          >
            {CREATIVE_CATEGORIES.map((item) => (
              <button
                key={item.id}
                disabled={!enabled}
                aria-pressed={item.id === category}
                onClick={() => setCategory(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className={styles.note}>{categories.description}</p>
          <div className={styles.cards}>
            {CREATIVE_TEMPLATES.filter(
              (item) => item.category === category,
            ).map((template) => (
              <button
                key={template.id}
                className={styles.card}
                aria-label={`Choose ${template.name}`}
                aria-pressed={selected?.id === template.id}
                disabled={!enabled}
                onClick={() => {
                  onChange({
                    ...brief,
                    format: template.format,
                    creative: {
                      path: "template",
                      category: template.category,
                      kind: template.kind,
                      templateId: template.id,
                      direction: creative.direction,
                      aspect: template.aspect,
                      seconds:
                        template.beats.reduce(
                          (sum, beat) => sum + beat.seconds,
                          0,
                        ) || 15,
                    },
                  });
                  onKind(template.kind);
                }}
              >
                <span
                  className={styles.composition}
                  data-category={template.category}
                  aria-hidden="true"
                >
                  <em>
                    {template.kind === "video"
                      ? "Motion study"
                      : "Composition study"}
                  </em>
                  <b>{template.name}</b>
                  <small>Creative brief · not a generated preview</small>
                </span>
                <span className={styles.cardBody}>
                  <strong>
                    {template.name}
                    {selected?.id === template.id && <Check size={13} />}
                  </strong>
                  <span>{template.description}</span>
                  <small>
                    {template.kind === "image" ? "Image" : "Video"} ·{" "}
                    {template.aspect}
                    {template.beats.length
                      ? ` · ${template.beats.length} beats`
                      : ""}
                  </small>
                </span>
              </button>
            ))}
          </div>
          {selected && (
            <div className={styles.selection}>
              <strong>Selected · {selected.name}</strong>
              <p>{selected.direction}</p>
              {!!selected.beats.length && (
                <div className={styles.steps}>
                  {selected.beats.map((beat, index) => (
                    <div key={index}>
                      <small>
                        {String(index + 1).padStart(2, "0")} · {beat.seconds}s
                      </small>
                      <strong>{beat.title}</strong>
                      <p>{beat.prompt}</p>
                    </div>
                  ))}
                </div>
              )}
              <div className={styles.actions}>
                {selected.beats.length > 0 && onBuildStoryboard && (
                  <button
                    className="suite-button"
                    disabled={!enabled}
                    onClick={onBuildStoryboard}
                  >
                    <Layers size={14} />
                    Build editable storyboard
                  </button>
                )}
                {selected.category === "posters" && (
                  <button
                    className="suite-button"
                    disabled={!enabled}
                    onClick={onDesign}
                  >
                    Open editable design <ArrowUpRight size={14} />
                  </button>
                )}
              </div>
            </div>
          )}
          <p className={styles.note}>
            These are original Moleculr creative briefs, rendered by the engine
            you review. The Ads presets and the connected account’s Template
            catalogue are below.
          </p>
        </>
      ) : (
        <p className={styles.note}>
          Start from approved product facts, selected original references and a
          specific creative direction. Engine settings and cost are reviewed
          before generation.
        </p>
      )}
      <fieldset disabled={!enabled} className="suite-fields">
        <label>
          {creative.path === "prompt"
            ? "Creative prompt"
            : "Template adjustments"}
          <textarea
            rows={4}
            maxLength={6000}
            value={creative.direction}
            placeholder={
              creative.path === "prompt"
                ? "Describe the composition, action, lighting and mood…"
                : "Add campaign-specific refinements while preserving the selected brief…"
            }
            onChange={(e) =>
              onChange({
                ...brief,
                creative: { ...creative, direction: e.target.value },
              })
            }
          />
        </label>
        <label>
          Creative aspect
          <select
            aria-label="Creative aspect"
            value={creative.aspect}
            onChange={(e) =>
              onChange({
                ...brief,
                creative: {
                  ...creative,
                  aspect: e.target.value as typeof creative.aspect,
                },
              })
            }
          >
            {["1:1", "4:5", "9:16", "16:9"].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <small>
            The generation review shows the chosen engine’s supported sizes.
          </small>
        </label>
      </fieldset>
    </section>
  );
}
