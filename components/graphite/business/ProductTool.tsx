"use client";
import { useRef, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { saveProduct } from "@/lib/workbench/moleculr-creative";
import type { MoleculrBrief } from "@/lib/workbench/moleculr";
import type { ProductExtraction } from "@/lib/workbench/product-extraction-types";
import type { LibraryEntry } from "@/lib/workspace/library";
import { OWN_LIMITS, chooseProduct, productLabel, unsavedProduct } from "@/lib/shell/business-own";
import { CardHead, Field, PicturePicker, Said, SaveLine, adoptEntry, briefOf, changeBrief, importToDraft, refreshLibrary, uploadToDraft, useLatest, useWork, type OwnEditor } from "./own-kit";

const BLANK: Partial<MoleculrBrief> = { activeProductId: undefined, productName: "", productUrl: "", productDescription: "", productBrand: "", productAssetIds: [], productSource: undefined };

/**
 * Business › Product: reusable product profiles (up to 24 a project) — name,
 * brand, approved facts and up to five original photographs — with a public
 * product page read and reviewed before any of it is used (the existing
 * extract route: free, one page, nothing added until you choose). The profile
 * being edited is the one every brief is about.
 */
export function ProductTool({ scope, editor, items }: { scope: string; editor: OwnEditor; items: LibraryEntry[] }) {
  const p = editor.project!;
  const latest = useLatest(p);
  const brief = briefOf(p);
  const profiles = brief.products ?? [];
  const work = useWork();
  const [extraction, setExtraction] = useState<ProductExtraction | null>(null);
  const [reviewFor, setReviewFor] = useState("");
  const [review, setReview] = useState({ name: "", brand: "", description: "" });
  const [imported, setImported] = useState<string[]>([]);
  const reading = useRef<AbortController | null>(null);
  const set = (patch: Partial<MoleculrBrief>) => changeBrief(editor, (b) => ({ ...b, ...patch }));
  const unsaved = unsavedProduct(brief);
  const full = !brief.activeProductId && profiles.length >= OWN_LIMITS.products;

  const pick = (id: string) => {
    const next = chooseProduct(briefOf(latest.current), id);
    if (!next.brief) { work.setError(next.problem); return; }
    changeBrief(editor, () => next.brief);
    setExtraction(null);
    work.setError("");
  };
  const save = () => {
    const id = brief.activeProductId || crypto.randomUUID();
    try {
      changeBrief(editor, (b) => saveProduct(b, id));
      void editor.ensureSaved();
      work.setError("");
      work.setNotice("The product profile is saved with this project.");
    } catch (cause) { work.setError(cause instanceof Error ? cause.message : "The profile could not be saved."); }
  };
  const fresh = () => {
    if (unsaved) { work.setError("Save this product as a profile before starting another."); return; }
    changeBrief(editor, (b) => ({ ...(b.activeProductId ? saveProduct(b, b.activeProductId) : b), ...BLANK }));
    setExtraction(null);
    work.setError("");
    work.setNotice("");
  };

  const readPage = () => work.run("read", async () => {
    let url: URL;
    try { url = new URL(brief.productUrl.trim()); } catch { throw new Error("Enter the product page, starting with https://"); }
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("Use a public http or https product page.");
    if (!(await editor.ensureSaved())) throw new Error("Save this project before reading the product page.");
    reading.current?.abort();
    const abort = new AbortController();
    reading.current = abort;
    setExtraction(null);
    const response = await fetch("/api/workbench/moleculr/extract-product", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
      body: JSON.stringify({ projectId: latest.current.id, url: url.href }), signal: abort.signal,
    });
    const data = await response.json().catch(() => ({})) as Partial<ProductExtraction> & { error?: string };
    if (!response.ok) throw new Error(data.error || "The product page could not be read.");
    if (!data.product || !data.source || !Array.isArray(data.imageCandidates) || !Array.isArray(data.evidence) || !Array.isArray(data.warnings) || data.requiresReview !== true)
      throw new Error("The product page returned an incomplete review. Try another page, or write the facts by hand.");
    if (briefOf(latest.current).productUrl.trim() !== brief.productUrl.trim()) return;
    setExtraction(data as ProductExtraction);
    setReviewFor(brief.productUrl.trim());
    setImported([]);
    setReview({ name: String(data.product.name ?? "").slice(0, 200), brand: String(data.product.brand ?? "").slice(0, 200), description: String(data.product.description ?? "").slice(0, 4000) });
    return "Review the page’s facts before using them. Page text is source material, not an approved claim.";
  });
  const useReview = () => {
    if (!extraction || !review.name.trim()) return;
    set({
      productName: review.name.trim().slice(0, 200), productUrl: extraction.source.finalUrl, productDescription: review.description.slice(0, 4000), productBrand: review.brand.slice(0, 200),
      productSource: { url: extraction.source.finalUrl, title: review.name.slice(0, 200), reviewedAt: new Date().toISOString() },
    });
    setReviewFor(extraction.source.finalUrl);
    work.setNotice("The reviewed facts are on the product. Save the profile to reuse it.");
  };

  /* ── Images: up to five of this project's originals. ── */
  const addImage = (id: string) => changeBrief(editor, (b) => (b.productAssetIds.includes(id) || b.productAssetIds.length >= OWN_LIMITS.productImages ? b : { ...b, productAssetIds: [...b.productAssetIds, id] }));
  const takeImage = (entry: LibraryEntry) => {
    const current = briefOf(latest.current);
    const asset = adoptEntry(editor, latest.current, entry, "Product");
    if (!asset) { work.setError("The project’s asset library is full."); return; }
    if (current.productAssetIds.includes(asset.id)) { changeBrief(editor, (b) => ({ ...b, productAssetIds: b.productAssetIds.filter((x) => x !== asset.id) })); return; }
    if (current.productAssetIds.length >= OWN_LIMITS.productImages) { work.setError(`A product takes up to ${OWN_LIMITS.productImages} images. Remove one first.`); return; }
    addImage(asset.id);
    work.setError("");
  };
  const uploadImage = (file: File) => work.run("upload", async () => {
    if (!file.type.startsWith("image/")) throw new Error(`${file.name} is not an image.`);
    if (briefOf(latest.current).productAssetIds.length >= OWN_LIMITS.productImages) throw new Error(`A product takes up to ${OWN_LIMITS.productImages} images. Remove one first.`);
    const asset = await uploadToDraft(scope, editor, latest.current, file, "Product", "Product photograph");
    addImage(asset.id);
    await editor.ensureSaved();
    refreshLibrary(scope, latest.current.id);
    return `${file.name} is one of the product’s images.`;
  });
  const importImage = (url: string) => work.run(url, async () => {
    const asset = await importToDraft(scope, editor, latest.current, url, "Product");
    const room = briefOf(latest.current).productAssetIds.length < OWN_LIMITS.productImages;
    if (room) addImage(asset.id);
    setImported((old) => [...old, url]);
    await editor.ensureSaved();
    refreshLibrary(scope, latest.current.id);
    return room ? "The original is imported and chosen as a product image." : `The original is in the Library. Five images are chosen already; swap one below.`;
  });

  const chosen = brief.productAssetIds.map((id) => p.assets.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => Boolean(a));
  const reviewing = Boolean(extraction) && reviewFor === brief.productUrl.trim();
  return (
    <div className="bo gx-enter" data-testid="product-tool">
      <section className="gx-gen-card" aria-label="Saved products" data-testid="product-profiles">
        <CardHead label={`Saved products · ${profiles.length} of ${OWN_LIMITS.products}`} />
        {profiles.length ? (
          <div className="gx-chips" role="group" aria-label="Saved products">
            {profiles.map((profile) => <button key={profile.id} type="button" className="gx-chip" aria-pressed={profile.id === brief.activeProductId} onClick={() => pick(profile.id)}>{productLabel(brief, profile)}</button>)}
          </div>
        ) : <p className="gx-hint">No saved products yet. Describe one below and save it as a profile.</p>}
        <div className="gx-gen-enhance">
          <button type="button" className="gx-primary" disabled={!brief.productName.trim() || full} onClick={save} data-testid="product-save">{brief.activeProductId ? "Save the profile" : "Save as a profile"}</button>
          <button type="button" className="gx-hbtn" disabled={profiles.length >= OWN_LIMITS.products && !brief.activeProductId} onClick={fresh} data-testid="product-new">+ New product</button>
          {brief.activeProductId ? <span className="gx-hint">Editing {brief.productName.trim() || "this product"}</span> : unsaved ? <span className="gx-hint">Not saved as a profile yet</span> : null}
        </div>
        {full ? <p className="gx-reason">This project holds 24 product profiles, the most it can.</p> : null}
      </section>

      <section className="gx-gen-card" aria-label="The product" data-testid="product-edit">
        <CardHead label="The product" />
        <Field label="Name"><input className="gx-field" value={brief.productName} maxLength={200} placeholder="What the campaign is for" onChange={(e) => set({ productName: e.target.value })} data-testid="product-name" /></Field>
        <Field label="Product page" hint="Read one public page, then review its facts and images before they are used.">
          <input className="gx-field" type="url" inputMode="url" value={brief.productUrl} maxLength={2000} placeholder="https://your-product.com" onChange={(e) => { setExtraction(null); work.setNotice(""); set({ productUrl: e.target.value }); }} data-testid="product-url" />
        </Field>
        <div className="gx-gen-enhance">
          <button type="button" className="gx-hbtn" disabled={Boolean(work.busy) || !brief.productUrl.trim()} onClick={() => void readPage()} data-testid="product-read">{work.busy === "read" ? "Reading the page…" : "Read the page · free"}</button>
          {brief.productSource ? <span className="gx-hint bo-url" data-testid="product-source">Reviewed from {brief.productSource.url}</span> : null}
        </div>
        <Field label="Brand"><input className="gx-field" value={brief.productBrand ?? ""} maxLength={200} placeholder="Brand or maker" onChange={(e) => set({ productBrand: e.target.value })} data-testid="product-brand" /></Field>
        <Field label="Approved facts"><textarea className="gx-textarea bo-short" value={brief.productDescription ?? ""} maxLength={4000} placeholder="Materials, features and the claims you can support" onChange={(e) => set({ productDescription: e.target.value })} data-testid="product-facts" /></Field>
        <Said error={work.error} notice={work.notice} testId="product" />
        {reviewing && extraction ? (
          <div className="bo-review" data-testid="product-review">
            <CardHead label="Review before using" />
            <p className="gx-hint bo-url">{extraction.source.finalUrl} · read {new Date(extraction.source.fetchedAt).toLocaleString()}</p>
            <Field label="Reviewed name"><input className="gx-field" value={review.name} maxLength={200} onChange={(e) => setReview({ ...review, name: e.target.value })} data-testid="product-review-name" /></Field>
            <Field label="Reviewed brand"><input className="gx-field" value={review.brand} maxLength={200} onChange={(e) => setReview({ ...review, brand: e.target.value })} /></Field>
            <Field label="Reviewed facts"><textarea className="gx-textarea bo-short" value={review.description} maxLength={4000} onChange={(e) => setReview({ ...review, description: e.target.value })} /></Field>
            {extraction.warnings.map((warning, i) => <p key={i} className="gx-reason">{warning}</p>)}
            <details className="bo-details">
              <summary className="bo-summary">Where each value came from · {extraction.evidence.length}</summary>
              <ul className="bo-evidence">{extraction.evidence.map((item, i) => <li key={i}><span className="bo-evidence-field">{item.field} · {item.source}</span><span>{item.value}</span></li>)}</ul>
            </details>
            <div className="gx-gen-enhance">
              <button type="button" className="gx-primary" disabled={!review.name.trim()} onClick={useReview} data-testid="product-use-review">Use the reviewed facts</button>
              <button type="button" className="gx-hbtn" onClick={() => setExtraction(null)}>Close the review</button>
            </div>
            {extraction.imageCandidates.length ? (
              <div className="bo-candidates" data-testid="product-candidates">
                <CardHead label="Images on the page" />
                <p className="gx-hint">Import only images you may use. Each comes in as an original in this project’s Library.</p>
                {extraction.imageCandidates.map((candidate, i) => {
                  const done = imported.includes(candidate.url);
                  return (
                    <div className="bo-candidate" key={candidate.url}>
                      <span className="bo-candidate-name">{candidate.alt || `Product image ${i + 1}`}<span className="gx-hint bo-url">{candidate.url}</span></span>
                      <button type="button" className="gx-hbtn" disabled={Boolean(work.busy) || done} onClick={() => void importImage(candidate.url)}>{done ? "Imported" : work.busy === candidate.url ? "Importing…" : "Import"}</button>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="gx-gen-card" aria-label="Product images" data-testid="product-images">
        <CardHead label={`Images · ${chosen.length} of ${OWN_LIMITS.productImages}`}><span className="gx-hint">Originals, never altered</span></CardHead>
        {chosen.length ? (
          <div className="bo-chosen" data-testid="product-chosen">
            {chosen.map((asset) => (
              <span className="bo-chosen-item" key={asset.id}>
                <span className="bo-thumb"><LazyMedia url={asset.url} kind="image" alt="" name={asset.name} className="gx-lazy" /></span>
                <span className="bo-slot-name">{asset.name}</span>
                <button type="button" className="gx-hbtn" aria-label={`Remove ${asset.name}`} onClick={() => changeBrief(editor, (b) => ({ ...b, productAssetIds: b.productAssetIds.filter((x) => x !== asset.id) }))}>×</button>
              </span>
            ))}
          </div>
        ) : <p className="gx-hint">Pick the product from every useful angle: stills from this project, or upload them.</p>}
        <PicturePicker items={items} label="Product pictures" chosen={chosen.map((a) => a.uploadId ?? a.generationId ?? a.id)} busy={work.busy === "upload"} onPick={takeImage} onUpload={(f) => void uploadImage(f)} testId="product-picker" />
      </section>
      <SaveLine editor={editor} testId="product-save-state" />
    </div>
  );
}
