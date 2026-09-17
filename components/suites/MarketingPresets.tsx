"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, RefreshCw, Search, Sparkles } from "lucide-react";
import type { Project } from "@/lib/workbench/studio";
import {
  marketingReferenceIds,
  moleculrReferences,
  type MoleculrBrief,
  type MoleculrMarketing,
  type MoleculrGenerationOptions,
} from "@/lib/workbench/moleculr";
import { AssetPreview } from "@/components/workbench/AssetPreview";
import styles from "./marketing-presets.module.css";

type Preset = { id: string; name: string; type: "ads" };
type Catalog = {
  scope: string;
  items: Preset[];
  total: number;
  cursor: string | null;
  configured: boolean;
  error: string;
  busy: boolean;
  loaded: boolean;
};
const emptyCatalog = (scope: string): Catalog => ({
  scope,
  items: [],
  total: 0,
  cursor: null,
  configured: false,
  error: "",
  busy: false,
  loaded: false,
});
const direct: MoleculrMarketing = { quality: "high", enhancePrompt: false };

export function MarketingPresets({
  project,
  brief,
  scope,
  enabled,
  hook,
  onSettings,
  onConfigure,
}: {
  project: Project;
  brief: MoleculrBrief;
  scope: string;
  enabled: boolean;
  hook: string;
  onSettings: (settings: MoleculrMarketing) => void;
  onConfigure: (
    hook: string,
    castId: string | undefined,
    kind: "image",
    options: MoleculrGenerationOptions,
  ) => void;
}) {
  const settings = brief.marketing ?? direct;
  const [catalog, setCatalog] = useState<Catalog>(() => emptyCatalog(scope));
  const [query, setQuery] = useState("");
  const [productId, setProductId] = useState("");
  const [castId, setCastId] = useState("");
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const readPage = useCallback(
    async (cursor?: string) => {
      const sequence = ++request.current;
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      setCatalog((before) => ({
        ...(cursor && before.scope === scope ? before : emptyCatalog(scope)),
        busy: true,
      }));
      try {
        const response = await fetch(
          `/api/higgsfield/marketing/presets${cursor ? `?${new URLSearchParams({ cursor })}` : ""}`,
          {
            cache: "no-store",
            headers: { "X-Workbench-Scope": scope },
            signal: abort.signal,
          },
        );
        const data = await response.json().catch(() => null);
        if (sequence !== request.current) return;
        if (!response.ok || !data?.configured || !Array.isArray(data.items))
          throw new Error(
            data?.error || "Marketing Studio presets could not be loaded.",
          );
        setCatalog((before) => ({
          scope,
          items: [
            ...new Map(
              [
                ...(cursor && before.scope === scope ? before.items : []),
                ...data.items,
              ].map((item: Preset) => [item.id, item]),
            ).values(),
          ],
          total: data.total,
          cursor: data.cursor ?? null,
          configured: true,
          error: "",
          busy: false,
          loaded: true,
        }));
      } catch (error) {
        if (sequence !== request.current || abort.signal.aborted) return;
        setCatalog((before) => ({
          ...before,
          scope,
          busy: false,
          loaded: true,
          error:
            error instanceof Error
              ? error.message
              : "Presets could not be loaded.",
        }));
      }
    },
    [scope],
  );
  useEffect(() => {
    if (enabled) void readPage();
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Invalidate the latest request, including user-triggered refreshes after this effect mounted.
      request.current++;
      controller.current?.abort();
    };
  }, [enabled, readPage]);
  const current = catalog.scope === scope ? catalog : emptyCatalog(scope);
  const products = brief.productAssetIds
    .map((id) =>
      project.assets.find((asset) => asset.id === id && asset.kind === "image"),
    )
    .filter((asset) => !!asset);
  const cast = brief.castAssetIds
    .map((id) =>
      project.assets.find((asset) => asset.id === id && asset.kind === "image"),
    )
    .filter((asset) => !!asset);
  const product =
    products.find((asset) => asset.id === productId) ?? products[0];
  const selectedCast = cast.find((asset) => asset.id === castId);
  const preset = current.items.find((item) => item.id === settings.presetId);
  const refs = settings.enhancePrompt
    ? marketingReferenceIds(project, brief, product?.id, selectedCast?.id)
    : moleculrReferences(
        project,
        { ...brief, castAssetIds: selectedCast ? [selectedCast.id] : [] },
        selectedCast?.id,
      ).map((asset) => asset.id);
  const allowed =
    enabled &&
    current.configured &&
    !current.busy &&
    !current.error &&
    (!settings.enhancePrompt || (!!preset && refs.length > 0));
  const visible = current.items.filter((item) =>
    item.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <section
      className={`suite-panel ${styles.panel}`}
      aria-label="Higgsfield Marketing Studio images"
    >
      <div className="suite-section-heading">
        <div>
          <h2>Campaign images</h2>
          <p>
            Direct your own image, or choose a live Higgsfield Marketing Studio
            preset.
          </p>
        </div>
        <span className="suite-badge">Higgsfield · Image</span>
      </div>
      <div className={styles.modes} aria-label="Campaign image approach">
        <button
          disabled={!enabled}
          aria-pressed={!settings.enhancePrompt}
          onClick={() =>
            onSettings({ quality: settings.quality, enhancePrompt: false })
          }
        >
          Your direction
          <span>Original prompt and selected product references</span>
        </button>
        <button
          disabled={!enabled}
          aria-pressed={settings.enhancePrompt}
          onClick={() =>
            onSettings({ ...settings, quality: "high", enhancePrompt: true })
          }
        >
          Provider preset
          <span>Product composition with an optional cast reference</span>
        </button>
      </div>
      {!enabled ? (
        <p className="suite-footnote">
          Open a saved project to discover presets and configure an image.
        </p>
      ) : current.error ? (
        <div className="suite-alert" role="alert">
          {current.error}
          <button className="suite-text-button" onClick={() => void readPage()}>
            <RefreshCw size={14} />
            Retry connection
          </button>
        </div>
      ) : !current.loaded ? (
        <p role="status" className="suite-footnote">
          Loading the connected preset catalog…
        </p>
      ) : null}
      {settings.enhancePrompt && (
        <div className={styles.catalog}>
          <label className={styles.search}>
            <Search size={15} />
            <span className="sr-only">Search available image presets</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search available presets"
            />
          </label>
          <div
            className={styles.presets}
            role="group"
            aria-label="Available image presets"
          >
            {visible.map((item) => (
              <button
                key={item.id}
                disabled={!enabled || current.busy}
                aria-pressed={item.id === settings.presetId}
                onClick={() =>
                  onSettings({
                    quality: "high",
                    enhancePrompt: true,
                    presetId: item.id,
                    presetName: item.name,
                  })
                }
              >
                <Sparkles size={16} />
                <span>
                  {item.name}
                  <small>Campaign image preset</small>
                </span>
                {item.id === settings.presetId && <Check size={15} />}
              </button>
            ))}
          </div>
          {current.loaded && !current.error && !visible.length && (
            <p className="suite-footnote">
              {query
                ? "No loaded presets match this search."
                : "This connection has no available image presets. Your direction remains available."}
            </p>
          )}
          <div className={styles.catalogFooter}>
            <span>
              {current.items.length} of {current.total} available presets
            </span>
            {current.cursor && (
              <button
                className="suite-text-button"
                disabled={current.busy || !enabled}
                onClick={() => void readPage(current.cursor!)}
              >
                {current.busy ? "Loading…" : "Load more presets"}
              </button>
            )}
            <button
              className="suite-text-button"
              disabled={!enabled || current.busy}
              onClick={() => void readPage()}
            >
              <RefreshCw size={13} />
              Refresh
            </button>
          </div>
          <div className={styles.detail}>
            <strong>
              {preset?.name ??
                settings.presetName ??
                "Choose an available preset"}
            </strong>
            <p>
              One product image leads the composition. Add one cast image to
              include a person. Presets use high quality; review the exact price
              before generating.
            </p>
            {settings.presetId && !preset && (
              <p role="status">
                The saved preset must be found in the current catalog before it
                can be used. Load more or choose another preset.
              </p>
            )}
          </div>
        </div>
      )}
      <fieldset
        disabled={!enabled}
        className={`suite-fields ${styles.references}`}
      >
        {settings.enhancePrompt ? (
          <label>
            Product image
            <select
              value={product?.id ?? ""}
              onChange={(event) => setProductId(event.target.value)}
            >
              <option value="" disabled>
                Select a product reference
              </option>
              {products.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.name}
                </option>
              ))}
            </select>
            {product && (
              <div className={styles.preview}>
                <AssetPreview asset={product} />
              </div>
            )}
          </label>
        ) : (
          <div>
            <strong>Product references</strong>
            <p className="suite-footnote">
              {products.length
                ? `${products.length} selected product image${products.length === 1 ? "" : "s"} will be included.`
                : "No image reference selected. Generate from your direction, or select images in Product."}
            </p>
          </div>
        )}
        <label>
          Cast reference
          <select
            value={selectedCast?.id ?? ""}
            onChange={(event) => setCastId(event.target.value)}
          >
            <option value="">Product only · no cast</option>
            {cast.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.name}
              </option>
            ))}
          </select>
          {selectedCast && (
            <div className={styles.preview}>
              <AssetPreview asset={selectedCast} />
            </div>
          )}
        </label>
        <label>
          Image quality
          <select
            value={settings.enhancePrompt ? "high" : settings.quality}
            disabled={settings.enhancePrompt}
            onChange={(event) =>
              onSettings({
                quality: event.target.value as MoleculrMarketing["quality"],
                enhancePrompt: false,
              })
            }
          >
            {["low", "medium", "high"].map((value) => (
              <option key={value} value={value}>
                {value.charAt(0).toUpperCase() + value.slice(1)}
              </option>
            ))}
          </select>
          <small>
            Resolution and aspect ratio are set in generation review.
          </small>
        </label>
      </fieldset>
      {settings.enhancePrompt && !products.length && (
        <p className="suite-alert">
          Choose an uploaded product image in Product before using a preset.
        </p>
      )}
      <footer className="suite-panel-footer">
        <span>Original references · quoted before generation</span>
        <button
          className="suite-primary"
          disabled={!allowed}
          onClick={() => {
            if (!allowed) return;
            onConfigure(
              hook.trim() || "Introduce the product clearly.",
              selectedCast?.id,
              "image",
              {
                modelId: "higgsfield/marketing-studio-image",
                marketing: {
                  quality: settings.enhancePrompt ? "high" : settings.quality,
                  enhancePrompt: settings.enhancePrompt,
                  ...(settings.enhancePrompt && preset
                    ? { presetId: preset.id }
                    : {}),
                },
                referenceAssetIds: refs,
              },
            );
          }}
        >
          Review campaign image
          <ArrowUpRight size={15} />
        </button>
      </footer>
    </section>
  );
}
