"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Download, Globe } from "lucide-react";
import type { BrandExtraction } from "@/lib/workbench/brand-extraction-types";
import { EMPTY_BRAND_KIT, brandKitSchema } from "@/lib/workbench/moleculr-creative";
import type { MoleculrBrief } from "@/lib/workbench/moleculr";
import type { Asset } from "@/lib/workbench/studio";
import styles from "./moleculr-creative.module.css";

export function BrandImport({ projectId, scope, brief, enabled, onChange, onSave, onImportRemote }: {
  projectId: string; scope: string; brief: MoleculrBrief; enabled: boolean;
  onChange: (brief: MoleculrBrief) => void; onSave?: () => Promise<boolean>;
  onImportRemote?: (url: string, category?: "Product" | "Brand") => Promise<Asset>;
}) {
  const website = brief.brandKit?.website ?? "";
  const [result, setResult] = useState<BrandExtraction | null>(null);
  const [reviewUrl, setReviewUrl] = useState("");
  const [review, setReview] = useState({ name: "", description: "", tagline: "", colors: "", fontFamilies: "" });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [imported, setImported] = useState<string[]>([]);
  const live = useRef({ brief, enabled, scope, projectId });
  useLayoutEffect(() => { live.current = { brief, enabled, scope, projectId }; }, [brief, enabled, scope, projectId]);
  const alive = useRef(true), pending = useRef(false), controller = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  const locked = !enabled || !!busy;
  const validReview = !!result && reviewUrl === website;
  const stillHere = (url: string) => alive.current && live.current.enabled && live.current.scope === scope && live.current.projectId === projectId && live.current.brief.brandKit?.website === url;
  async function extract() {
    if (locked || pending.current || !website.trim()) return;
    pending.current = true; setBusy("read"); setError(""); setNotice(""); setResult(null);
    const abort = new AbortController(); controller.current = abort;
    try {
      if (onSave && !(await onSave())) throw new Error("Save the project before reading its brand website.");
      if (!stillHere(website)) return;
      const response = await fetch("/api/workbench/moleculr/extract-brand", { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope }, body: JSON.stringify({ projectId, url: website }), signal: abort.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The brand website could not be read.");
      if (!data.brand || !data.source || !Array.isArray(data.brand.colors) || !Array.isArray(data.brand.fontFamilies) || !Array.isArray(data.logoCandidates) || !Array.isArray(data.imageryCandidates) || !Array.isArray(data.evidence) || !Array.isArray(data.warnings) || data.requiresReview !== true) throw new Error("The website returned an incomplete brand review. Enter the details manually or try another page.");
      if (!stillHere(website)) return;
      setResult(data); setReviewUrl(website); setImported([]);
      setReview({ name: String(data.brand.name ?? "").slice(0, 200), description: String(data.brand.description ?? "").slice(0, 4000), tagline: String(data.brand.tagline ?? "").slice(0, 300), colors: data.brand.colors.slice(0, 8).join(", "), fontFamilies: data.brand.fontFamilies.slice(0, 8).join(", ") });
    } catch (reason) { if (alive.current && !abort.signal.aborted) setError(reason instanceof Error ? reason.message : "Brand extraction failed."); }
    finally { pending.current = false; if (alive.current) setBusy(""); }
  }
  function apply() {
    if (!validReview || locked) return;
    try {
      const current = live.current.brief;
      const colors = [...new Set(review.colors.split(",").map(value => value.trim()).filter(Boolean))];
      const fonts = [...new Set(review.fontFamilies.split(",").map(value => value.trim()).filter(Boolean))];
      const kit = brandKitSchema.safeParse({ ...(current.brandKit ?? EMPTY_BRAND_KIT), name: review.name, description: review.description, tagline: review.tagline, ...(colors.length ? { colors } : {}), ...(fonts.length ? { fontFamilies: fonts } : {}), source: { url: result!.source.finalUrl, reviewedAt: new Date().toISOString() } });
      if (!kit.success) throw new Error("Use up to eight #RRGGBB colours and eight font names of no more than 120 characters.");
      onChange({ ...current, brandKit: kit.data }); setError(""); setNotice("Reviewed brand details applied. Voice, audience and logo stay editable below.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Brand details could not be applied."); }
  }
  async function importImage(url: string, logo: boolean) {
    if (!onImportRemote || locked || pending.current || !validReview || imported.includes(url)) return;
    pending.current = true; setBusy(url); setError("");
    try {
      const asset = await onImportRemote(url, "Brand");
      if (!stillHere(reviewUrl)) return;
      if (asset.kind !== "image") throw new Error("This candidate is not a supported image.");
      if (logo) { const current = live.current.brief; onChange({ ...current, brandKit: { ...(current.brandKit ?? EMPTY_BRAND_KIT), logoAssetId: asset.id } }); }
      setImported(previous => [...previous, url]); setNotice(logo ? "Original logo imported and attached to the brand kit." : "Original brand image saved in the project library.");
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "The image could not be imported."); }
    finally { pending.current = false; if (alive.current) setBusy(""); }
  }
  return <section className={styles.review} aria-label="Import brand from website">
    <div className="suite-section-heading"><div><h3>Start from your website.</h3><p>Extract the brand name, copy, colour and typography signals, then review them before applying. Images are imported only when you choose them.</p></div><Globe size={20}/></div>
    <label>Brand website<input type="url" value={website} maxLength={2000} disabled={locked} placeholder="https://yourbrand.com" onChange={event => { setResult(null); setError(""); setNotice(""); onChange({ ...brief, brandKit: { ...(brief.brandKit ?? EMPTY_BRAND_KIT), website: event.target.value } }); }}/></label>
    <button className="suite-button" type="button" disabled={locked || !website.trim()} onClick={() => void extract()}><Globe size={15}/>{busy === "read" ? "Reading website…" : "Extract brand"}</button>
    {error && <p role="alert" className="suite-alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {validReview && <div>
      <h3>Review extracted identity</h3>
      <p>Only visible website signals are included. Missing tone or audience details need your direction.</p>
      <fieldset className="suite-fields" disabled={locked}>
        <label>Extracted brand name<input value={review.name} maxLength={200} onChange={event => setReview({ ...review, name: event.target.value })}/></label>
        <label>Extracted tagline<input value={review.tagline} maxLength={300} onChange={event => setReview({ ...review, tagline: event.target.value })}/></label>
        <label>Extracted brand description<textarea aria-label="Extracted brand description" value={review.description} rows={3} maxLength={4000} onChange={event => setReview({ ...review, description: event.target.value })}/></label>
        <label>Extracted colours<input value={review.colors} maxLength={100} placeholder="#112233, #FFFFFF" onChange={event => setReview({ ...review, colors: event.target.value })}/></label>
        <label>Extracted font names<input value={review.fontFamilies} maxLength={970} onChange={event => setReview({ ...review, fontFamilies: event.target.value })}/><small>Recorded as brand direction. No external font files are loaded.</small></label>
      </fieldset>
      <button className="suite-primary" type="button" disabled={locked} onClick={apply}>Apply reviewed brand</button>
      <details><summary>Sources and extraction notes</summary><ul className={styles.evidence}>{result!.evidence.map((item, index) => <li key={index}><strong>{item.field} · {item.source}</strong><span>{item.value}</span><small>{item.sourceUrl}</small></li>)}</ul>{result!.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>
      {[{ title: "Logo candidates", items: result!.logoCandidates, logo: true }, { title: "Brand imagery", items: result!.imageryCandidates, logo: false }].map(group => group.items.length > 0 && <div key={group.title}><h3>{group.title}</h3><div className={styles.candidates}>{group.items.map((item, index) => {
        const unsupported = /\.(?:svg|gif)(?:[?#]|$)/i.test(item.url);
        return <div className={styles.candidate} key={`${item.url}:${index}`}><span>{item.alt || (group.logo ? "Logo" : "Brand image")}<small>{item.url}</small>{unsupported && <small>Upload a PNG, JPEG, WebP or AVIF version from your computer.</small>}</span><button className="suite-button" type="button" disabled={locked || unsupported || !onImportRemote || imported.includes(item.url)} onClick={() => void importImage(item.url, group.logo)}><Download size={14}/>{imported.includes(item.url) ? "Imported" : group.logo ? "Import logo" : "Import image"}</button></div>;
      })}</div></div>)}
    </div>}
  </section>;
}
