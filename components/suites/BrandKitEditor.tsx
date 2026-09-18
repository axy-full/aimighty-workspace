"use client";

import type { MoleculrBrief } from "@/lib/workbench/moleculr";
import type { Asset, Project } from "@/lib/workbench/studio";
import { BrandImport } from "./BrandImport";
import styles from "./moleculr-creative.module.css";

const emptyKit: NonNullable<MoleculrBrief["brandKit"]> = {
  name: "",
  tagline: "",
  voice: "",
  audience: "",
  colors: [],
  font: "system",
};

export function BrandKitEditor({
  project,
  brief,
  enabled,
  onChange,
  onUpload,
  scope,
  onSave,
  onImportRemote,
}: {
  project: Project;
  brief: MoleculrBrief;
  enabled: boolean;
  onChange: (brief: MoleculrBrief) => void;
  onUpload: () => void;
  scope: string;
  onSave?: () => Promise<boolean>;
  onImportRemote?: (url: string, category?: "Product" | "Brand") => Promise<Asset>;
}) {
  const kit = brief.brandKit ?? emptyKit;
  const set = <K extends keyof typeof kit>(key: K, value: (typeof kit)[K]) =>
    onChange({ ...brief, brandKit: { ...kit, [key]: value } });
  return (
    <section className="suite-panel" aria-label="Brand kit">
      <div className="suite-section-heading">
        <div>
          <h2>Your brand, in every frame.</h2>
          <p>
            Save the identity, voice and visual rules your campaign should
            follow.
          </p>
        </div>
        <span className="suite-badge">Brand kit</span>
      </div>
      <BrandImport key={`${scope}:${project.id}`} projectId={project.id} scope={scope} brief={brief} enabled={enabled} onChange={onChange} onSave={onSave} onImportRemote={onImportRemote}/>
      <fieldset disabled={!enabled} className="suite-fields">
        <label>
          Brand name
          <input
            value={kit.name}
            maxLength={200}
            placeholder="Brand or studio name"
            onChange={(e) => set("name", e.target.value)}
          />
        </label>
        <label>
          Brand description
          <textarea aria-label="Brand description" rows={3} value={kit.description ?? ""} maxLength={4000} onChange={e => set("description", e.target.value)} placeholder="Approved facts about the brand and what it offers"/>
        </label>
        <label>
          Tagline
          <input
            value={kit.tagline}
            maxLength={300}
            placeholder="The promise you want people to remember"
            onChange={(e) => set("tagline", e.target.value)}
          />
        </label>
        <label>
          Brand voice
          <textarea
            aria-label="Brand voice"
            rows={3}
            value={kit.voice}
            maxLength={2000}
            placeholder="How the brand speaks. What should it always—or never—sound like?"
            onChange={(e) => set("voice", e.target.value)}
          />
        </label>
        <label>
          Brand audience
          <textarea
            aria-label="Brand audience"
            rows={3}
            value={kit.audience}
            maxLength={2000}
            placeholder="Who this is for, and what matters to them"
            onChange={(e) => set("audience", e.target.value)}
          />
        </label>
        <label>
          Typography
          <select
            aria-label="Brand typography"
            value={kit.font}
            onChange={(e) => set("font", e.target.value as typeof kit.font)}
          >
            <option value="system">System · clear and practical</option>
            <option value="editorial">Editorial · expressive serif</option>
            <option value="geometric">Geometric · structured sans</option>
          </select>
        </label>
        <div>
          <label>
            Brand logo
            <select
              aria-label="Brand logo"
              value={kit.logoAssetId ?? ""}
              onChange={(e) => set("logoAssetId", e.target.value || undefined)}
            >
              <option value="">No logo selected</option>
              {project.assets
                .filter((a) => a.kind === "image")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            className="suite-text-button"
            onClick={onUpload}
          >
            Upload a logo
          </button>
        </div>
      </fieldset>
      {!!kit.fontFamilies?.length && <p className={styles.note}>Recorded typefaces: {kit.fontFamilies.join(" · ")}. These names guide creative work; they do not load external fonts.</p>}
      {kit.source && <p className={styles.note}>Website identity reviewed from {kit.source.url}.</p>}
      <div className={styles.palette} aria-label="Brand palette">
        <div>
          <strong>Brand colours</strong>
          <p>Use approved hex colours for your artwork and editable posters.</p>
        </div>
        <div className={styles.swatches}>
          {kit.colors.map((color, index) => (
            <div key={index} className={styles.swatch}>
              <input
                aria-label={`Brand colour ${index + 1}`}
                type="color"
                value={color}
                disabled={!enabled}
                onChange={(e) =>
                  set(
                    "colors",
                    kit.colors.map((value, i) =>
                      i === index ? e.target.value : value,
                    ),
                  )
                }
              />
              <span>{color.toUpperCase()}</span>
              <button
                className="suite-text-button"
                aria-label={`Remove brand colour ${index + 1}`}
                disabled={!enabled}
                onClick={() =>
                  set(
                    "colors",
                    kit.colors.filter((_, i) => i !== index),
                  )
                }
              >
                Remove
              </button>
            </div>
          ))}
          {kit.colors.length < 8 && (
            <button
              className="suite-button"
              disabled={!enabled}
              onClick={() => set("colors", [...kit.colors, "#5cc8b4"])}
            >
              Add colour
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
