"use client";

import { useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Check,
  Download,
  ImagePlus,
  Plus,
  UserRound,
  Video,
} from "lucide-react";
import type { Asset, Project, Stage } from "@/lib/workbench/studio";
import {
  EMPTY_MOLECULR,
  MOLECULR_FORMATS,
  variantAssets,
  type MoleculrBrief,
} from "@/lib/workbench/moleculr";
import { originalAssetDownload } from "@/lib/workbench/original-asset";
import { AssetPreview } from "@/components/workbench/AssetPreview";

export function MoleculrWorkspace({
  project,
  page,
  enabled,
  marketing,
  onChange,
  onPage,
  onUpload,
  onIdentity,
  onStage,
  onRig,
  onGenerate,
  onSequence,
  onAgent,
}: {
  project: Project;
  page: string;
  enabled: boolean;
  marketing: ReactNode;
  onChange: (brief: MoleculrBrief) => void;
  onPage: (page: string) => void;
  onUpload: (category: string) => void;
  onIdentity: (assetId?: string) => void;
  onStage: (stage: Stage) => void;
  onRig: (nodeId: string) => void;
  onGenerate: (
    hook: string,
    castId: string | undefined,
    kind: "image" | "video",
  ) => void;
  onSequence: (asset: Asset) => void;
  onAgent: () => void;
}) {
  const brief = project.moleculr ?? EMPTY_MOLECULR;
  const [hookIndex, setHookIndex] = useState(0);
  const [castId, setCastId] = useState("");
  const [media, setMedia] = useState<"image" | "video">("video");
  const images = project.assets.filter((asset) => asset.kind === "image");
  const cast = images.filter(
    (asset) =>
      asset.category === "Character" ||
      !!asset.soulIdentityId ||
      brief.castAssetIds.includes(asset.id),
  );
  const outputs = variantAssets(project, brief);
  const hooks = brief.hooks.filter((hook) => hook.trim());
  const selectedHook = hooks[hookIndex] ?? hooks[0] ?? "";
  const selectedCast = brief.castAssetIds.includes(castId)
    ? castId
    : brief.castAssetIds[0];
  const set = <K extends keyof MoleculrBrief>(
    key: K,
    value: MoleculrBrief[K],
  ) => onChange({ ...brief, [key]: value });
  const toggle = (
    key: "productAssetIds" | "castAssetIds",
    id: string,
    limit: number,
  ) => {
    const values = brief[key];
    set(
      key,
      values.includes(id)
        ? values.filter((value) => value !== id)
        : values.length < limit
          ? [...values, id]
          : values,
    );
  };
  const title =
    {
      product: "The product, precisely.",
      cast: "Give the campaign a character.",
      format: "Find the right expression.",
      variants: "One idea. Considered variations.",
      publish: "Ready for the next screen.",
    }[page] ?? "Your marketing studio.";
  return (
    <div className="suite-workspace moleculr-workspace" data-page={page}>
      <header className="suite-page-intro">
        <div>
          <span className="suite-kicker">
            <i className="suite-dot" style={{ background: "#5CC8B4" }} />
            Moleculr / {project.name}
          </span>
          <h1>{title}</h1>
          <p>
            Product, cast and campaign assets stay connected to this project.
          </p>
        </div>
        <button className="suite-button" onClick={onAgent}>
          Ask Atomik <ArrowUpRight size={15} />
        </button>
      </header>
      {page === "product" && (
        <>
          <section className="suite-panel suite-product-profile">
            <div className="suite-section-heading">
              <div>
                <h2>Product profile</h2>
                <p>
                  Use your approved product information and original
                  photography.
                </p>
              </div>
              <span className="suite-badge">Saved with project</span>
            </div>
            <fieldset className="suite-fields" disabled={!enabled}>
              <label>
                Product name
                <input
                  value={brief.productName}
                  maxLength={200}
                  placeholder="What are we making a campaign for?"
                  onChange={(e) => set("productName", e.target.value)}
                />
              </label>
              <label>
                Product URL
                <input
                  type="url"
                  value={brief.productUrl}
                  maxLength={2000}
                  placeholder="https://your-product.com"
                  onChange={(e) => set("productUrl", e.target.value)}
                />
                <small>
                  Saved as a reference. Add product facts in the campaign brief;
                  this does not scrape the page.
                </small>
              </label>
            </fieldset>
          </section>
          <section className="suite-panel">
            <div className="suite-section-heading">
              <div>
                <h2>Product references</h2>
                <p>
                  Select up to five images. Original uploads remain in the
                  shared library.
                </p>
              </div>
              <button
                className="suite-button"
                disabled={!enabled}
                onClick={() => onUpload("Product")}
              >
                <ImagePlus size={15} />
                Upload
              </button>
            </div>
            {images.length ? (
              <div className="suite-asset-grid">
                {images.map((asset) => (
                  <button
                    className="suite-asset-choice"
                    aria-label={asset.name}
                    key={asset.id}
                    aria-pressed={brief.productAssetIds.includes(asset.id)}
                    disabled={
                      !enabled ||
                      (!brief.productAssetIds.includes(asset.id) &&
                        brief.productAssetIds.length >= 5)
                    }
                    onClick={() => toggle("productAssetIds", asset.id, 5)}
                  >
                    <AssetPreview asset={asset} />
                    <span>
                      {asset.name}
                      {brief.productAssetIds.includes(asset.id) && (
                        <Check size={15} />
                      )}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="suite-empty">
                <ImagePlus size={24} />
                <p>Bring in the product from every useful angle.</p>
                <button
                  className="suite-button"
                  disabled={!enabled}
                  onClick={() => onUpload("Product")}
                >
                  Upload product photographs
                </button>
              </div>
            )}
            <footer className="suite-panel-footer">
              <span>{brief.productAssetIds.length} / 5 selected</span>
              <button className="suite-primary" onClick={() => onPage("cast")}>
                Continue to cast <ArrowUpRight size={15} />
              </button>
            </footer>
          </section>
        </>
      )}
      {page === "cast" && (
        <section className="suite-panel">
          <div className="suite-section-heading">
            <div>
              <h2>Campaign cast</h2>
              <p>
                Reuse project characters and Soul identities. Select up to six.
              </p>
            </div>
            <button
              className="suite-button"
              disabled={!enabled}
              onClick={() => onUpload("Character")}
            >
              <Plus size={15} />
              Upload character
            </button>
          </div>
          {cast.length ? (
            <div className="suite-asset-grid">
              {cast.map((asset) => (
                <article key={asset.id} className="suite-cast-card">
                  <button
                    className="suite-asset-choice"
                    aria-label={asset.name}
                    aria-pressed={brief.castAssetIds.includes(asset.id)}
                    disabled={
                      !enabled ||
                      (!brief.castAssetIds.includes(asset.id) &&
                        brief.castAssetIds.length >= 6)
                    }
                    onClick={() => toggle("castAssetIds", asset.id, 6)}
                  >
                    <AssetPreview asset={asset} />
                    <span>
                      {asset.name}
                      {brief.castAssetIds.includes(asset.id) && (
                        <Check size={15} />
                      )}
                    </span>
                  </button>
                  <button
                    className="suite-text-button"
                    disabled={!enabled}
                    onClick={() => onIdentity(asset.id)}
                  >
                    {asset.soulIdentityId
                      ? "Open Soul identity"
                      : "Create Soul identity"}{" "}
                    <ArrowUpRight size={13} />
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <div className="suite-empty">
              <UserRound size={24} />
              <p>Add a character reference, or make a product-only campaign.</p>
              <button
                className="suite-button"
                disabled={!enabled}
                onClick={() => onIdentity()}
              >
                Create a Soul identity
              </button>
            </div>
          )}
          <footer className="suite-panel-footer">
            <span>
              {brief.castAssetIds.length
                ? `${brief.castAssetIds.length} cast references selected`
                : "Product-only · no cast reference"}
            </span>
            <button className="suite-primary" onClick={() => onPage("format")}>
              Continue to format <ArrowUpRight size={15} />
            </button>
          </footer>
        </section>
      )}
      {page === "format" && (
        <>
          <section className="suite-panel">
            <div className="suite-section-heading">
              <div>
                <h2>Campaign format</h2>
                <p>
                  The format becomes creative direction for your existing image
                  and video engines.
                </p>
              </div>
            </div>
            <div className="suite-format-grid">
              {MOLECULR_FORMATS.map((format) => (
                <button
                  key={format.id}
                  className="suite-format"
                  aria-pressed={brief.format === format.id}
                  disabled={!enabled}
                  onClick={() => set("format", format.id)}
                >
                  <strong>{format.label}</strong>
                  <span>{format.description}</span>
                  {brief.format === format.id && <Check size={15} />}
                </button>
              ))}
            </div>
            <fieldset disabled={!enabled} className="suite-fields">
              <label>
                Campaign hooks
                <textarea
                  value={brief.hooks.join("\n")}
                  placeholder="One hook per line, up to 12"
                  rows={4}
                  onChange={(e) =>
                    set(
                      "hooks",
                      e.target.value
                        .split("\n")
                        .slice(0, 12)
                        .map((hook) => hook.slice(0, 500)),
                    )
                  }
                />
                <small>
                  Each hook can be paired with a cast reference in Variants.
                </small>
              </label>
              <label>
                Creative direction
                <textarea
                  value={brief.notes}
                  maxLength={6000}
                  rows={4}
                  placeholder="Mood, camera, lighting, pacing and product details to preserve"
                  onChange={(e) => set("notes", e.target.value)}
                />
              </label>
            </fieldset>
            <footer className="suite-panel-footer">
              <span>{hooks.length} campaign hooks</span>
              <button
                className="suite-primary"
                onClick={() => onPage("variants")}
              >
                Build variants <ArrowUpRight size={15} />
              </button>
            </footer>
          </section>
          <div className="suite-marketing-tools">{marketing}</div>
        </>
      )}
      {page === "variants" && (
        <>
          <section className="suite-panel">
            <div className="suite-section-heading">
              <div>
                <h2>Hook × cast</h2>
                <p>
                  Choose a combination, then review the engine, references and
                  credit quote before generating.
                </p>
              </div>
              <span className="suite-badge">
                {hooks.length * Math.max(1, brief.castAssetIds.length)}{" "}
                combinations
              </span>
            </div>
            {hooks.length ? (
              <div className="suite-variant-controls">
                <label>
                  Hook
                  <select
                    value={Math.min(hookIndex, hooks.length - 1)}
                    onChange={(e) => setHookIndex(Number(e.target.value))}
                  >
                    {hooks.map((hook, index) => (
                      <option key={index} value={index}>
                        {hook}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Cast
                  <select
                    value={selectedCast ?? ""}
                    onChange={(e) => setCastId(e.target.value)}
                  >
                    {!brief.castAssetIds.length && (
                      <option value="">Product only</option>
                    )}
                    {brief.castAssetIds.map((id) => (
                      <option value={id} key={id}>
                        {project.assets.find((asset) => asset.id === id)
                          ?.name ?? "Missing reference"}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Output
                  <select
                    value={media}
                    onChange={(e) =>
                      setMedia(e.target.value as "image" | "video")
                    }
                  >
                    <option value="video">Video</option>
                    <option value="image">Image</option>
                  </select>
                </label>
                <button
                  className="suite-primary"
                  disabled={!enabled}
                  onClick={() => onGenerate(selectedHook, selectedCast, media)}
                >
                  Configure generation <ArrowUpRight size={15} />
                </button>
              </div>
            ) : (
              <div className="suite-empty">
                <p>Add a campaign hook to start a variant.</p>
                <button
                  className="suite-button"
                  onClick={() => onPage("format")}
                >
                  Write campaign hooks
                </button>
              </div>
            )}
            {!!brief.variants.length && (
              <div className="suite-run-list">
                {brief.variants
                  .slice()
                  .reverse()
                  .map((variant) => {
                    const assets = outputs.filter(
                      (asset) => asset.nodeId === variant.nodeId,
                    );
                    return (
                      <div key={variant.id}>
                        <span>
                          <strong>{variant.hook}</strong>
                          <small>
                            {project.assets.find(
                              (asset) => asset.id === variant.castAssetId,
                            )?.name ?? "Product only"}
                          </small>
                        </span>
                        <span>
                          {assets.length
                            ? `${assets.length} saved take${assets.length === 1 ? "" : "s"}`
                            : "Configured · see Atomik activity"}
                        </span>
                        <button
                          className="suite-text-button"
                          onClick={() => onRig(variant.nodeId)}
                        >
                          Open in Rig <ArrowUpRight size={13} />
                        </button>
                      </div>
                    );
                  })}
              </div>
            )}
          </section>
          <OutputGallery assets={outputs} onSequence={onSequence} />
        </>
      )}
      {page === "publish" && (
        <>
          <section className="suite-panel">
            <div className="suite-section-heading">
              <div>
                <h2>Campaign delivery</h2>
                <p>
                  Review full-resolution outputs, build the edit and export the
                  delivery package.
                </p>
              </div>
              <button
                className="suite-primary"
                onClick={() => onStage("export")}
              >
                Open delivery <ArrowUpRight size={15} />
              </button>
            </div>
            <div className="suite-delivery-actions">
              <button className="suite-format" onClick={() => onStage("edit")}>
                <Video size={19} />
                <strong>Edit & sound</strong>
                <span>Sequence, grade, mix and finish your campaign.</span>
              </button>
              <button
                className="suite-format"
                onClick={() => onStage("export")}
              >
                <Download size={19} />
                <strong>Export package</strong>
                <span>Original media, edit decisions and project context.</span>
              </button>
            </div>
            <p className="suite-footnote">
              Social publishing is not connected. Download your approved
              deliverables and publish through your channel’s account.
            </p>
          </section>
          <OutputGallery assets={outputs} onSequence={onSequence} />
        </>
      )}
    </div>
  );
}

function OutputGallery({
  assets,
  onSequence,
}: {
  assets: Asset[];
  onSequence: (asset: Asset) => void;
}) {
  return (
    <section className="suite-panel">
      <div className="suite-section-heading">
        <div>
          <h2>Campaign takes</h2>
          <p>Completed variant outputs from this project.</p>
        </div>
        <span className="suite-badge">{assets.length} takes</span>
      </div>
      {assets.length ? (
        <div className="suite-output-grid">
          {assets.map((asset) => {
            const original = originalAssetDownload(asset);
            return (
              <article key={asset.id}>
                <AssetPreview asset={asset} />
                <h3>{asset.name}</h3>
                <div>
                  {original && (
                    <a
                      className="suite-text-button"
                      href={original.url}
                      download={original.filename}
                    >
                      <Download size={13} />
                      Original
                    </a>
                  )}
                  <button
                    className="suite-text-button"
                    onClick={() => onSequence(asset)}
                  >
                    <Plus size={13} />
                    Add to edit
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="suite-empty">
          <Video size={24} />
          <p>
            Completed variants will appear here and in your project library.
          </p>
        </div>
      )}
    </section>
  );
}
