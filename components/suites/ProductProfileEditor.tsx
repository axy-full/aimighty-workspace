"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Globe, Plus, Save } from "lucide-react";
import type { MoleculrBrief } from "@/lib/workbench/moleculr";
import { saveProduct, switchProduct } from "@/lib/workbench/moleculr-creative";
import type { Asset, Project } from "@/lib/workbench/studio";
import type { ProductExtraction } from "@/lib/workbench/product-extraction-types";
import styles from "./moleculr-creative.module.css";

export function ProductProfileEditor({
  project,
  brief,
  scope,
  enabled,
  onChange,
  onSave,
  onImportRemote,
}: {
  project: Project;
  brief: MoleculrBrief;
  scope: string;
  enabled: boolean;
  onChange: (brief: MoleculrBrief) => void;
  onSave?: () => Promise<boolean>;
  onImportRemote?: (url: string) => Promise<Asset>;
}) {
  const [extraction, setExtraction] = useState<ProductExtraction | null>(null);
  const [reviewForUrl, setReviewForUrl] = useState(brief.productUrl);
  const [review, setReview] = useState({
    name: "",
    description: "",
    brand: "",
  });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [imported, setImported] = useState<string[]>([]);
  const pending = useRef(false),
    alive = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const latest = useRef(brief);
  useEffect(() => {
    latest.current = brief;
  }, [brief]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  const locked = !enabled || !!busy;
  const profiles = brief.products ?? [];
  const unsavedDraft =
    !brief.activeProductId &&
    !!(
      brief.productName.trim() ||
      brief.productUrl.trim() ||
      brief.productDescription?.trim() ||
      brief.productBrand?.trim() ||
      brief.productAssetIds.length
    );
  const set = <K extends keyof MoleculrBrief>(
    key: K,
    value: MoleculrBrief[K],
  ) => onChange({ ...brief, [key]: value });
  async function extract() {
    if (locked || pending.current) return;
    pending.current = true;
    setBusy("extract");
    setError("");
    setNotice("");
    setExtraction(null);
    const abort = new AbortController();
    controller.current = abort;
    try {
      const url = new URL(brief.productUrl);
      if (!["https:", "http:"].includes(url.protocol))
        throw new Error("Use a public http or https product page.");
      if (onSave && !(await onSave()))
        throw new Error("Save this project before reading the product page.");
      if (!alive.current) return;
      const response = await fetch("/api/workbench/moleculr/extract-product", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Workbench-Scope": scope,
        },
        body: JSON.stringify({ projectId: project.id, url: url.href }),
        signal: abort.signal,
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "The product page could not be read.");
      if (
        !data.product ||
        !data.source ||
        !Array.isArray(data.imageCandidates) ||
        !Array.isArray(data.evidence) ||
        !Array.isArray(data.warnings) ||
        data.requiresReview !== true
      )
        throw new Error(
          "The product page returned an incomplete review. Try another page or enter the facts manually.",
        );
      if (!alive.current) return;
      setExtraction(data as ProductExtraction);
      setReviewForUrl(brief.productUrl);
      setReview({
        name: String(data.product.name ?? "").slice(0, 200),
        description: String(data.product.description ?? "").slice(0, 4000),
        brand: String(data.product.brand ?? "").slice(0, 200),
      });
      setImported([]);
    } catch (cause) {
      if (alive.current && !abort.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "The product page could not be read.",
        );
    } finally {
      pending.current = false;
      if (alive.current) setBusy("");
    }
  }
  async function importImage(url: string) {
    if (!onImportRemote || locked || pending.current || imported.includes(url))
      return;
    pending.current = true;
    setBusy(url);
    setError("");
    try {
      const asset = await onImportRemote(url);
      if (!alive.current) return;
      const current = latest.current;
      if (asset.kind !== "image")
        throw new Error(
          "This candidate was not an image. Select a product photograph instead.",
        );
      if (
        current.productAssetIds.length < 5 ||
        current.productAssetIds.includes(asset.id)
      ) {
        onChange({
          ...current,
          productAssetIds: [...new Set([...current.productAssetIds, asset.id])],
        });
        setNotice(
          "Original image imported and selected as a product reference.",
        );
      } else
        setNotice(
          "Original image imported to the library. Five references are already selected; choose which to use below.",
        );
      setImported((before) => [...before, url]);
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : "Image import failed.",
        );
    } finally {
      pending.current = false;
      if (alive.current) setBusy("");
    }
  }
  return (
    <section className="suite-panel suite-product-profile">
      <div className="suite-section-heading">
        <div>
          <h2>Product library</h2>
          <p>
            Keep reusable profiles, approved facts and original photographs
            together.
          </p>
        </div>
        <span className="suite-badge">{profiles.length} / 24 profiles</span>
      </div>
      <div className={styles.profiles}>
        <label>
          Saved product
          <select
            aria-label="Saved product"
            value={brief.activeProductId ?? ""}
            disabled={locked}
            onChange={(e) => {
              if (e.target.value) {
                if (unsavedDraft) {
                  setError(
                    "Save the current product profile before switching products.",
                  );
                  return;
                }
                onChange(switchProduct(brief, e.target.value));
              }
            }}
          >
            <option value="">Current product draft</option>
            {profiles.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name || "Untitled product"}
              </option>
            ))}
          </select>
        </label>
        <button
          className="suite-button"
          disabled={
            locked ||
            !brief.productName.trim() ||
            (!brief.activeProductId && profiles.length >= 24)
          }
          onClick={() => {
            const id = brief.activeProductId || crypto.randomUUID();
            onChange(saveProduct(brief, id));
            setNotice("Product profile saved with this project.");
          }}
        >
          <Save size={14} />
          Save profile
        </button>
        <button
          className="suite-text-button"
          disabled={locked || profiles.length >= 24 || unsavedDraft}
          title={
            !brief.activeProductId && brief.productName.trim()
              ? "Save the current product before starting another."
              : undefined
          }
          onClick={() => {
            const saved = brief.activeProductId
              ? saveProduct(brief, brief.activeProductId)
              : brief;
            onChange({
              ...saved,
              activeProductId: undefined,
              productName: "",
              productUrl: "",
              productDescription: "",
              productBrand: "",
              productAssetIds: [],
              productSource: undefined,
            });
          }}
        >
          <Plus size={14} />
          New product
        </button>
      </div>
      <fieldset className="suite-fields" disabled={locked}>
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
            onChange={(e) => {
              setExtraction(null);
              setNotice("");
              set("productUrl", e.target.value);
            }}
          />
          <small>
            Read a public product page, then review its facts and image
            candidates before adding them.
          </small>
        </label>
        <label>
          Product brand
          <input
            value={brief.productBrand ?? ""}
            maxLength={200}
            placeholder="Brand or manufacturer"
            onChange={(e) => set("productBrand", e.target.value)}
          />
        </label>
        <label>
          Approved product facts
          <textarea
            value={brief.productDescription ?? ""}
            rows={4}
            maxLength={4000}
            placeholder="Materials, features and supported claims"
            onChange={(e) => set("productDescription", e.target.value)}
          />
        </label>
      </fieldset>
      <div className={styles.actions}>
        <button
          className="suite-button"
          disabled={locked || !brief.productUrl.trim()}
          onClick={() => void extract()}
        >
          <Globe size={14} />
          {busy === "extract" ? "Reading product page…" : "Review product page"}
        </button>
        {brief.productSource && (
          <span className={styles.note}>
            Reviewed source: {brief.productSource.url}
          </span>
        )}
      </div>
      {error && (
        <p className="suite-alert" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.note}>
          {notice}
        </p>
      )}
      {extraction && brief.productUrl === reviewForUrl && (
        <section className={styles.review} aria-label="Product page review">
          <h3>Review before adding</h3>
          <p>{extraction.source.finalUrl}</p>
          <p>
            Fetched {new Date(extraction.source.fetchedAt).toLocaleString()}.
            Page text is source material; verify claims before using them.
          </p>
          <fieldset className="suite-fields" disabled={locked}>
            <label>
              Reviewed name
              <input
                value={review.name}
                maxLength={200}
                onChange={(e) => setReview({ ...review, name: e.target.value })}
              />
            </label>
            <label>
              Reviewed brand
              <input
                value={review.brand}
                maxLength={200}
                onChange={(e) =>
                  setReview({ ...review, brand: e.target.value })
                }
              />
            </label>
            <label>
              Reviewed description
              <textarea
                rows={4}
                value={review.description}
                maxLength={4000}
                onChange={(e) =>
                  setReview({ ...review, description: e.target.value })
                }
              />
            </label>
          </fieldset>
          {extraction.warnings.map((warning, index) => (
            <p key={index} className="suite-alert">
              {warning}
            </p>
          ))}
          <details>
            <summary>Source evidence · {extraction.evidence.length}</summary>
            <ul className={styles.evidence}>
              {extraction.evidence.map((item, index) => (
                <li key={index}>
                  <strong>
                    {item.field} · {item.source}
                  </strong>
                  {item.value}
                </li>
              ))}
            </ul>
          </details>
          <button
            className="suite-primary"
            disabled={locked || !review.name.trim()}
            onClick={() => {
              onChange({
                ...brief,
                productName: review.name.trim().slice(0, 200),
                productUrl: extraction.source.finalUrl,
                productDescription: review.description.slice(0, 4000),
                productBrand: review.brand.slice(0, 200),
                productSource: {
                  url: extraction.source.finalUrl,
                  title: review.name.slice(0, 200),
                  reviewedAt: new Date().toISOString(),
                },
              });
              setReviewForUrl(extraction.source.finalUrl);
              setNotice(
                "Reviewed product facts added. Save the profile to reuse this product.",
              );
            }}
          >
            Use reviewed product facts
          </button>
          {!!extraction.imageCandidates.length && (
            <>
              <h4>Image candidates</h4>
              <p>
                Import only images you are permitted to use. Originals are added
                to the shared project library.
              </p>
              <div className={styles.candidates}>
                {extraction.imageCandidates.map((candidate, index) => (
                  <div className={styles.candidate} key={candidate.url}>
                    <span>
                      {candidate.alt || `Product image ${index + 1}`}
                      <small>{candidate.url}</small>
                    </span>
                    <button
                      className="suite-button"
                      disabled={
                        locked ||
                        !onImportRemote ||
                        imported.includes(candidate.url)
                      }
                      onClick={() => void importImage(candidate.url)}
                    >
                      <ArrowDownToLine size={13} />
                      {imported.includes(candidate.url)
                        ? "Imported"
                        : busy === candidate.url
                          ? "Importing…"
                          : "Import original"}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
          <button
            className="suite-text-button"
            disabled={locked}
            onClick={() => setExtraction(null)}
          >
            Close review
          </button>
        </section>
      )}
    </section>
  );
}
