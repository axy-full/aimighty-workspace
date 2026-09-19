"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
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
  type MoleculrGenerationOptions,
} from "@/lib/workbench/moleculr";
import { originalAssetDownload } from "@/lib/workbench/original-asset";
import { AssetPreview } from "@/components/workbench/AssetPreview";
import { MarketingPresets } from "./MarketingPresets";
import { BrandKitEditor } from "./BrandKitEditor";
import { ProductProfileEditor } from "./ProductProfileEditor";
import { CreativeTemplateBrowser } from "./CreativeTemplateBrowser";
import { ReferenceAd } from "./ReferenceAd";
import { ConsumerMarketingVideo } from "./ConsumerMarketingVideo";
import { EMPTY_REFERENCE_AD } from "@/lib/workbench/reference-ad";
import { MOLECULR_SECTIONS } from "@/lib/suites";
import {
  DEFAULT_CREATIVE,
  creativeTemplate,
} from "@/lib/workbench/moleculr-creative";
import creativeStyles from "./moleculr-creative.module.css";

export function MoleculrWorkspace({
  project,
  scope,
  page,
  section = null,
  enabled,
  marketing,
  design = null,
  onChange,
  onPage,
  onUpload,
  onIdentity,
  onStage,
  onRig,
  onGenerate,
  onSequence,
  onAgent,
  onSave,
  onImportRemote,
  onCreateAvatar,
  onBuildStoryboard,
  onReviewVariant,
  onPrepareVariants,
  onConsumerVideoAsset,
}: {
  project: Project;
  scope: string;
  page: string;
  /** The Marketing Studio section a link or route asked for (`marketing#brand`). */
  section?: string | null;
  enabled: boolean;
  marketing: ReactNode;
  /** The poster designer, rendered inside the Design section. */
  design?: ReactNode;
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
    options?: MoleculrGenerationOptions,
  ) => void;
  onSequence: (asset: Asset) => void;
  onAgent: () => void;
  onSave?: () => Promise<boolean>;
  onImportRemote?: (url: string, category?: "Product" | "Brand") => Promise<Asset>;
  onCreateAvatar?: (prompt: string) => void;
  onBuildStoryboard?: () => void;
  onReviewVariant?: (nodeId: string) => void;
  onPrepareVariants?: (kind: "image" | "video") => void;
  onConsumerVideoAsset?: (asset: Asset, draftId: string) => Promise<void>;
}) {
  const brief = project.moleculr ?? EMPTY_MOLECULR;
  const [hookIndex, setHookIndex] = useState(0);
  const [castId, setCastId] = useState("__default");
  const [media, setMedia] = useState<"image" | "video">(
    () => brief.creative?.kind ?? creativeTemplate(brief)?.kind ?? "image",
  );
  const [avatarPrompt, setAvatarPrompt] = useState("");
  const images = project.assets.filter((asset) => asset.kind === "image");
  const cast = images.filter(
    (asset) =>
      asset.category === "Character" ||
      !!asset.soulIdentityId ||
      brief.castAssetIds.includes(asset.id),
  );
  const outputs = [...new Map([...variantAssets(project, brief), ...project.assets.filter(asset => asset.category === "Campaign video")].map(asset => [asset.id, asset])).values()];
  const hooks = brief.hooks.filter((hook) => hook.trim());
  const selectedHook = hooks[hookIndex] ?? hooks[0] ?? "";
  const selectedCast =
    castId === ""
      ? undefined
      : brief.castAssetIds.includes(castId)
        ? castId
        : brief.castAssetIds[0];
  const combinations =
    new Set(hooks.map((hook) => hook.trim())).size *
    Math.max(1, new Set(brief.castAssetIds).size);
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
  // One section is open at a time, like the former pages; anchors and links still name every section.
  const [openSection, setOpenSection] = useState(section ?? MOLECULR_SECTIONS[0].id);
  useEffect(() => {
    if (!section) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A route hash or a section link chooses the open section.
    setOpenSection(section);
    document.getElementById(section)?.scrollIntoView({ block: "start" });
  }, [section]);
  return (
    <div
      className={`suite-workspace moleculr-workspace ${creativeStyles.workspace}`}
      data-page={page}
    >
      <header className="suite-page-intro">
        <div>
          <span className="suite-kicker">
            <i className="suite-dot" style={{ background: "#5CC8B4" }} />
            Moleculr Business Suite / {project.name}
          </span>
          <h1>Your marketing studio.</h1>
          <p>
            Product, brand, cast, format, variants, design and publishing stay
            together on one page, connected to this project.
          </p>
        </div>
        <button className="suite-button" onClick={onAgent}>
          Ask Atomik Super Agent <ArrowUpRight size={15} />
        </button>
      </header>
      <nav className="moleculr-sections-nav" aria-label="Marketing Studio sections">
        {MOLECULR_SECTIONS.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            aria-current={openSection === item.id ? "location" : undefined}
            onClick={(event) => {
              event.preventDefault();
              onPage(item.id);
            }}
          >
            {item.label}
          </a>
        ))}
      </nav>
      <section className="moleculr-section" id="product" aria-labelledby="moleculr-product-title">
        <h2 id="moleculr-product-title">
          <button type="button" className="moleculr-section-toggle" aria-expanded={openSection === "product"} aria-controls="moleculr-product-body" onClick={() => onPage("product")}>
            <span>The product, precisely.</span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        </h2>
        {openSection === "product" && (
          <div id="moleculr-product-body" className="moleculr-section-body">
          <ProductProfileEditor
            key={`${scope}:${project.id}:${brief.activeProductId ?? "draft"}`}
            project={project}
            brief={brief}
            scope={scope}
            enabled={enabled}
            onChange={onChange}
            onSave={onSave}
            onImportRemote={onImportRemote}
          />
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
          </div>
        )}
      </section>
      <section className="moleculr-section" id="brand" aria-labelledby="moleculr-brand-title">
        <h2 id="moleculr-brand-title">
          <button type="button" className="moleculr-section-toggle" aria-expanded={openSection === "brand"} aria-controls="moleculr-brand-body" onClick={() => onPage("brand")}>
            <span>Build a brand worth knowing.</span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        </h2>
        {openSection === "brand" && (
          <div id="moleculr-brand-body" className="moleculr-section-body">
          <section className="suite-panel">
            <div className="suite-section-heading">
              <div>
                <h2>Brand direction</h2>
                <p>
                  Define what the brand stands for, who it serves and what makes
                  its offer distinctive. Develop positioning and campaigns with
                  the project’s approved facts and references.
                </p>
              </div>
              <span className="suite-badge">Saved with project</span>
            </div>
            <div className="suite-step-row">
              {[
                ["Position", "Audience, offer and the reason to choose you."],
                [
                  "Express",
                  "Tone, visual language and consistent brand assets.",
                ],
                [
                  "Produce",
                  "Campaign images, films and reviewable variations.",
                ],
              ].map(([label, text]) => (
                <div key={label}>
                  <strong>{label}</strong>
                  <span>{text}</span>
                </div>
              ))}
            </div>
          </section>
          <BrandKitEditor
            project={project}
            brief={brief}
            scope={scope}
            enabled={enabled}
            onChange={onChange}
            onUpload={() => onUpload("Brand")}
            onSave={onSave}
            onImportRemote={onImportRemote}
          />
          <div className="suite-marketing-tools">{marketing}</div>
          <footer className="suite-panel-footer">
            <span>
              Strategy and approved product claims guide the creative work.
            </span>
            <button className="suite-primary" onClick={() => onPage("product")}>
              Build the product library
              <ArrowUpRight size={15} />
            </button>
          </footer>
          </div>
        )}
      </section>
      <section className="moleculr-section" id="cast" aria-labelledby="moleculr-cast-title">
        <h2 id="moleculr-cast-title">
          <button type="button" className="moleculr-section-toggle" aria-expanded={openSection === "cast"} aria-controls="moleculr-cast-body" onClick={() => onPage("cast")}>
            <span>Give the campaign a character.</span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        </h2>
        {openSection === "cast" && (
          <div id="moleculr-cast-body" className="moleculr-section-body">
        <section className="suite-panel">
          <div className="suite-section-heading">
            <div>
              <h2>Campaign cast</h2>
              <p>
                Reuse project characters and identities. Select up to six.
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
                      ? "Open identity"
                      : "Create identity"}{" "}
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
                Create an identity
              </button>
            </div>
          )}
          {onCreateAvatar && (
            <fieldset className="suite-fields" disabled={!enabled}>
              <label>
                New avatar direction
                <textarea
                  rows={3}
                  maxLength={4000}
                  value={avatarPrompt}
                  onChange={(event) => setAvatarPrompt(event.target.value)}
                  placeholder="Describe an adult campaign presenter, styling, lighting and framing…"
                />
                <small>
                  Create a new portrait through generation review, then use the
                  saved original as a cast reference.
                </small>
              </label>
              <button
                className="suite-button"
                disabled={!avatarPrompt.trim()}
                onClick={() => onCreateAvatar(avatarPrompt.trim())}
              >
                Review new avatar <ArrowUpRight size={14} />
              </button>
            </fieldset>
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
          </div>
        )}
      </section>
      <section className="moleculr-section" id="format" aria-labelledby="moleculr-format-title">
        <h2 id="moleculr-format-title">
          <button type="button" className="moleculr-section-toggle" aria-expanded={openSection === "format"} aria-controls="moleculr-format-body" onClick={() => onPage("format")}>
            <span>Find the right expression.</span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        </h2>
        {openSection === "format" && (
          <div id="moleculr-format-body" className="moleculr-section-body">
          <CreativeTemplateBrowser
            brief={brief}
            enabled={enabled}
            onChange={onChange}
            onKind={setMedia}
            onBuildStoryboard={onBuildStoryboard}
            onDesign={() => onPage("design")}
          />
          {media === "video" && <ReferenceAd project={project} scope={scope} onSave={onSave} enabled={enabled} value={brief.referenceAd ?? EMPTY_REFERENCE_AD} onChange={referenceAd => onChange({ ...brief, referenceAd })}/>}
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
            <fieldset className="suite-fields" disabled={!enabled}>
              <label>
                Production format
                <select
                  aria-label="Production format"
                  value={brief.format}
                  onChange={(event) =>
                    onChange({
                      ...brief,
                      format: event.target.value as MoleculrBrief["format"],
                      ...(brief.creative
                        ? {
                            creative: {
                              ...brief.creative,
                              path: "prompt",
                              templateId: undefined,
                            },
                          }
                        : {}),
                    })
                  }
                >
                  {MOLECULR_FORMATS.map((format) => (
                    <option key={format.id} value={format.id}>
                      {format.label}
                    </option>
                  ))}
                </select>
                <small>
                  Choosing another production format switches to your prompt
                  direction.
                </small>
              </label>
            </fieldset>
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
          <MarketingPresets
            project={project}
            brief={brief}
            scope={scope}
            enabled={enabled}
            hook={selectedHook}
            onSettings={(settings) => set("marketing", settings)}
            onConfigure={onGenerate}
          />
          </div>
        )}
      </section>
      <section className="moleculr-section" id="variants" aria-labelledby="moleculr-variants-title">
        <h2 id="moleculr-variants-title">
          <button type="button" className="moleculr-section-toggle" aria-expanded={openSection === "variants"} aria-controls="moleculr-variants-body" onClick={() => onPage("variants")}>
            <span>One idea. Considered variations.</span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        </h2>
        {openSection === "variants" && (
          <div id="moleculr-variants-body" className="moleculr-section-body">
          {media === "video" && <ReferenceAd project={project} scope={scope} onSave={onSave} enabled={enabled} value={brief.referenceAd ?? EMPTY_REFERENCE_AD} onChange={referenceAd => onChange({ ...brief, referenceAd })}/>}
          <section className="suite-panel">
            <div className="suite-section-heading">
              <div>
                <h2>Hook × cast</h2>
                <p>
                  Choose a combination, then review the engine, references and
                  credit quote before generating.
                </p>
              </div>
              <span className="suite-badge">{combinations} combinations</span>
            </div>
            <div className="suite-fields">
              <label>
                Output
                <select
                  aria-label="Output"
                  disabled={!enabled}
                  value={media}
                  onChange={(event) => {
                    const kind = event.target.value as "image" | "video";
                    setMedia(kind);
                    onChange({
                      ...brief,
                      creative: {
                        ...(brief.creative ?? {
                          ...DEFAULT_CREATIVE,
                          path: "prompt",
                        }),
                        kind,
                      },
                    });
                  }}
                >
                  <option value="image">
                    Campaign image · Higgsfield Marketing Studio
                  </option>
                  <option value="video">
                    Campaign video · Particl engines
                  </option>
                </select>
              </label>
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
                {media === "video" && (
                  <label>
                    Cast
                    <select
                      aria-label="Video cast"
                      value={selectedCast ?? ""}
                      onChange={(e) => setCastId(e.target.value)}
                    >
                      <option value="">Product only</option>
                      {brief.castAssetIds.map((id) => (
                        <option value={id} key={id}>
                          {project.assets.find((asset) => asset.id === id)
                            ?.name ?? "Missing reference"}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {media === "video" && (
                  <button
                    className="suite-primary"
                    disabled={!enabled}
                    onClick={() =>
                      onGenerate(
                        selectedHook,
                        selectedCast,
                        media,
                        brief.creative
                          ? {
                              ratio: brief.creative.aspect,
                              duration: brief.creative.seconds,
                            }
                          : undefined,
                      )
                    }
                  >
                    Configure generation <ArrowUpRight size={15} />
                  </button>
                )}
              </div>
            ) : (
              <div className="suite-empty">
                <p>
                  {media === "image"
                    ? "An image can start from your brand direction. Add hooks to develop distinct campaign variations."
                    : "Add a campaign hook to start a video variant."}
                </p>
                {media === "video" &&
                (creativeTemplate(brief) ||
                  brief.creative?.direction.trim()) ? (
                  <button
                    className="suite-primary"
                    disabled={!enabled}
                    onClick={() =>
                      onGenerate(
                        creativeTemplate(brief)?.name ||
                          "Introduce the product clearly.",
                        selectedCast,
                        "video",
                        brief.creative
                          ? {
                              ratio: brief.creative.aspect,
                              duration: brief.creative.seconds,
                            }
                          : undefined,
                      )
                    }
                  >
                    Configure generation <ArrowUpRight size={15} />
                  </button>
                ) : (
                  <button
                    className="suite-button"
                    onClick={() => onPage("format")}
                  >
                    Write campaign hooks
                  </button>
                )}
              </div>
            )}
            {onPrepareVariants && (
              <div className="suite-panel-footer">
                <div>
                  <button
                    className="suite-button"
                    disabled={!enabled || !hooks.length || combinations > 24}
                    onClick={() => onPrepareVariants(media)}
                  >
                    Prepare hook × cast variants <Plus size={14} />
                  </button>
                  <p className="suite-footnote">
                    Prepare editable nodes for every hook and selected cast.
                    Each render is quoted separately.
                    {media === "image" && brief.marketing?.enhancePrompt
                      ? " Preset variations use the first selected product image with each cast reference."
                      : ""}
                    {combinations > 24
                      ? " Reduce the selection to 24 combinations or fewer."
                      : ""}
                  </p>
                </div>
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
                            : "Draft · ready to review"}
                        </span>
                        <button
                          className="suite-text-button"
                          onClick={() => onRig(variant.nodeId)}
                        >
                          Open in Rig <ArrowUpRight size={13} />
                        </button>
                        {onReviewVariant && (
                          <button
                            className="suite-text-button"
                            disabled={!enabled}
                            onClick={() => onReviewVariant(variant.nodeId)}
                          >
                            Review generation <ArrowUpRight size={13} />
                          </button>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
          </section>
          {media === "image" && (
            <MarketingPresets
              project={project}
              brief={brief}
              scope={scope}
              enabled={enabled}
              hook={selectedHook}
              onSettings={(settings) => set("marketing", settings)}
              onConfigure={onGenerate}
            />
          )}
          {media === "video" && <ConsumerMarketingVideo key={`${scope}:${project.id}`} project={project} scope={scope} enabled={enabled} onSave={onSave} onAsset={onConsumerVideoAsset}/>}
          <OutputGallery assets={outputs} onSequence={onSequence} />
          </div>
        )}
      </section>
      <section className="moleculr-section" id="design" aria-labelledby="moleculr-design-title">
        <h2 id="moleculr-design-title">
          <button type="button" className="moleculr-section-toggle" aria-expanded={openSection === "design"} aria-controls="moleculr-design-body" onClick={() => onPage("design")}>
            <span>Every layer, considered.</span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        </h2>
        {openSection === "design" && (
          <div id="moleculr-design-body" className="moleculr-section-body">
        {design}
          </div>
        )}
      </section>
      <section className="moleculr-section" id="publish" aria-labelledby="moleculr-publish-title">
        <h2 id="moleculr-publish-title">
          <button type="button" className="moleculr-section-toggle" aria-expanded={openSection === "publish"} aria-controls="moleculr-publish-body" onClick={() => onPage("publish")}>
            <span>Ready for the next screen.</span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        </h2>
        {openSection === "publish" && (
          <div id="moleculr-publish-body" className="moleculr-section-body">
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
                <strong>Edit & Sound</strong>
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
          </div>
        )}
      </section>
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
