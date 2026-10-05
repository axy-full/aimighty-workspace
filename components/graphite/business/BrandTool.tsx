"use client";
import { useRef, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import type { BrandExtraction } from "@/lib/workbench/brand-extraction-types";
import { EMPTY_BRAND_KIT, brandKitSchema, type BrandKit } from "@/lib/workbench/moleculr-creative";
import type { LibraryEntry } from "@/lib/workspace/library";
import { OWN_LIMITS } from "@/lib/shell/business-own";
import { CardHead, Field, PicturePicker, Said, SaveLine, adoptEntry, briefOf, changeBrief, importToDraft, refreshLibrary, uploadToDraft, useLatest, useWork, type OwnEditor } from "./own-kit";

const FONTS: [BrandKit["font"], string][] = [["system", "System"], ["geometric", "Geometric"], ["editorial", "Editorial"]];
const HEX = /^#[\da-f]{6}$/i;
type Review = { name: string; description: string; tagline: string; colors: string; fontFamilies: string };

/**
 * Business › Brand: the brand kit, read from the brand's own website and
 * reviewed before anything is used (the existing extract route reads one
 * public page — free — and returns observations, never an approved kit), then
 * edited by hand: name, words, voice, audience, typography, logo and palette.
 * Every brief, hook and poster made in Business carries it.
 */
export function BrandTool({ scope, editor, items, initial }: { scope: string; editor: OwnEditor; items: LibraryEntry[]; /** A read of the site already made (the Ads board's), opened for review. */ initial?: BrandExtraction | null }) {
  const p = editor.project!;
  const latest = useLatest(p);
  const brief = briefOf(p);
  const kit = brief.brandKit ?? EMPTY_BRAND_KIT;
  const work = useWork();
  const [result, setResult] = useState<BrandExtraction | null>(initial ?? null);
  const [reviewFor, setReviewFor] = useState(initial ? (kit.website ?? "").trim() : "");
  const [review, setReview] = useState<Review>(() => initial
    ? { name: String(initial.brand.name ?? "").slice(0, 200), description: String(initial.brand.description ?? "").slice(0, 4000), tagline: String(initial.brand.tagline ?? "").slice(0, 300), colors: initial.brand.colors.slice(0, OWN_LIMITS.colors).join(", "), fontFamilies: initial.brand.fontFamilies.slice(0, OWN_LIMITS.fontFamilies).join(", ") }
    : { name: "", description: "", tagline: "", colors: "", fontFamilies: "" });
  const [imported, setImported] = useState<string[]>([]);
  const [logoOpen, setLogoOpen] = useState(false);
  const reading = useRef<AbortController | null>(null);
  const website = kit.website ?? "";
  const reviewing = Boolean(result) && reviewFor === website.trim();
  const setKit = (patch: Partial<BrandKit>) => changeBrief(editor, (b) => ({ ...b, brandKit: { ...(b.brandKit ?? EMPTY_BRAND_KIT), ...patch } }));

  const read = () => work.run("read", async () => {
    const url = website.trim();
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("Enter the brand’s website, starting with https://"); }
    if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("Use a public http or https website.");
    if (!(await editor.ensureSaved())) throw new Error("Save the project before reading its brand website.");
    reading.current?.abort();
    const abort = new AbortController();
    reading.current = abort;
    setResult(null);
    const response = await fetch("/api/workbench/moleculr/extract-brand", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
      body: JSON.stringify({ projectId: latest.current.id, url: parsed.href }), signal: abort.signal,
    });
    const data = await response.json().catch(() => ({})) as Partial<BrandExtraction> & { error?: string };
    if (!response.ok) throw new Error(data.error || "The brand website could not be read.");
    if (!data.brand || !data.source || !Array.isArray(data.brand.colors) || !Array.isArray(data.brand.fontFamilies) || !Array.isArray(data.logoCandidates) || !Array.isArray(data.imageryCandidates) || !Array.isArray(data.evidence) || !Array.isArray(data.warnings) || data.requiresReview !== true)
      throw new Error("The website returned an incomplete review. Enter the details by hand, or try another page.");
    /* The website changed while it was read: this review is for another address. */
    if ((briefOf(latest.current).brandKit?.website ?? "").trim() !== url) return;
    setResult(data as BrandExtraction);
    setReviewFor(url);
    setImported([]);
    setReview({ name: String(data.brand.name ?? "").slice(0, 200), description: String(data.brand.description ?? "").slice(0, 4000), tagline: String(data.brand.tagline ?? "").slice(0, 300), colors: data.brand.colors.slice(0, OWN_LIMITS.colors).join(", "), fontFamilies: data.brand.fontFamilies.slice(0, OWN_LIMITS.fontFamilies).join(", ") });
    return "Review what the website shows, then apply it. Nothing is used until you do.";
  });

  const apply = () => {
    if (!result) return;
    const colors = [...new Set(review.colors.split(",").map((v) => v.trim()).filter(Boolean))];
    const fonts = [...new Set(review.fontFamilies.split(",").map((v) => v.trim()).filter(Boolean))];
    const current = briefOf(latest.current).brandKit ?? EMPTY_BRAND_KIT;
    const next = brandKitSchema.safeParse({ ...current, name: review.name, description: review.description, tagline: review.tagline, ...(colors.length ? { colors } : {}), ...(fonts.length ? { fontFamilies: fonts } : {}), source: { url: result.source.finalUrl, reviewedAt: new Date().toISOString() } });
    if (!next.success) { work.setError("Use up to eight #RRGGBB colours and eight font names of up to 120 characters."); return; }
    changeBrief(editor, (b) => ({ ...b, brandKit: next.data }));
    work.setError("");
    work.setNotice("The reviewed brand is applied. Voice, audience and logo stay yours to write below.");
  };

  const importImage = (url: string, logo: boolean) => work.run(url, async () => {
    const asset = await importToDraft(scope, editor, latest.current, url, "Brand");
    if (logo) setKit({ logoAssetId: asset.id });
    setImported((old) => [...old, url]);
    void editor.ensureSaved();
    return logo ? "The logo is imported as an original and set on the brand kit." : "The image is imported as an original into this project’s Library.";
  });

  const takeLogo = (entry: LibraryEntry) => {
    const asset = adoptEntry(editor, latest.current, entry, "Brand");
    if (!asset) { work.setError("The project’s asset library is full."); return; }
    setKit({ logoAssetId: asset.id });
    setLogoOpen(false);
    void editor.ensureSaved();
  };
  const uploadLogo = (file: File) => work.run("logo", async () => {
    if (!file.type.startsWith("image/")) throw new Error(`${file.name} is not an image.`);
    const asset = await uploadToDraft(scope, editor, latest.current, file, "Brand", "Brand logo");
    setKit({ logoAssetId: asset.id });
    setLogoOpen(false);
    await editor.ensureSaved();
    refreshLibrary(scope, latest.current.id);
    return `${file.name} is the brand’s logo.`;
  });

  const logo = kit.logoAssetId ? p.assets.find((a) => a.id === kit.logoAssetId) : undefined;
  const colors = kit.colors;
  return (
    <div className="bo gx-enter" data-testid="brand-tool">
      <section className="gx-gen-card" aria-label="Start from your website" data-testid="brand-website">
        <CardHead label="Start from your website"><span className="gx-hint">Free</span></CardHead>
        <p className="gx-hint">Particl reads one public page for the name, words, colours and type it shows. Nothing is used until you review it; images come in only when you choose them.</p>
        <Field label="Brand website">
          <input className="gx-field" type="url" inputMode="url" value={website} maxLength={2000} placeholder="https://yourbrand.com" disabled={Boolean(work.busy)}
            onChange={(e) => { setResult(null); work.setError(""); work.setNotice(""); setKit({ website: e.target.value }); }} data-testid="brand-url" />
        </Field>
        <div className="gx-gen-enhance">
          <button type="button" className="gx-primary" disabled={Boolean(work.busy) || !website.trim()} onClick={() => void read()} data-testid="brand-read">{work.busy === "read" ? "Reading the website…" : "Read the website"}</button>
        </div>
        <Said error={work.error} notice={work.notice} testId="brand" />
        {reviewing && result ? (
          <div className="bo-review" data-testid="brand-review">
            <CardHead label="Review what it shows" />
            <p className="gx-hint">From {result.source.finalUrl}. Only what the page shows is here; its voice and audience are yours to write.</p>
            <Field label="Name"><input className="gx-field" value={review.name} maxLength={200} onChange={(e) => setReview({ ...review, name: e.target.value })} data-testid="brand-review-name" /></Field>
            <Field label="Tagline"><input className="gx-field" value={review.tagline} maxLength={300} onChange={(e) => setReview({ ...review, tagline: e.target.value })} /></Field>
            <Field label="Description"><textarea className="gx-textarea bo-short" value={review.description} maxLength={4000} onChange={(e) => setReview({ ...review, description: e.target.value })} /></Field>
            <Field label="Colours" hint="Up to eight, as #RRGGBB."><input className="gx-field" value={review.colors} maxLength={100} placeholder="#112233, #FFFFFF" onChange={(e) => setReview({ ...review, colors: e.target.value })} data-testid="brand-review-colors" /></Field>
            <Field label="Typefaces" hint="Recorded as direction; no font files are loaded."><input className="gx-field" value={review.fontFamilies} maxLength={970} onChange={(e) => setReview({ ...review, fontFamilies: e.target.value })} /></Field>
            {result.warnings.map((warning, i) => <p key={i} className="gx-reason">{warning}</p>)}
            <div className="gx-gen-enhance">
              <button type="button" className="gx-primary" disabled={Boolean(work.busy)} onClick={apply} data-testid="brand-apply">Apply the reviewed brand</button>
              <button type="button" className="gx-hbtn" onClick={() => setResult(null)}>Close the review</button>
            </div>
            <details className="bo-details">
              <summary className="bo-summary">Where each value came from · {result.evidence.length}</summary>
              <ul className="bo-evidence">{result.evidence.map((item, i) => <li key={i}><span className="bo-evidence-field">{item.field} · {item.source}</span><span>{item.value}</span></li>)}</ul>
            </details>
            {[{ title: "Logo candidates", list: result.logoCandidates, logo: true }, { title: "Brand imagery", list: result.imageryCandidates, logo: false }].map((group) => group.list.length ? (
              <div className="bo-candidates" key={group.title} data-testid={group.logo ? "brand-logos" : "brand-imagery"}>
                <CardHead label={group.title} />
                {group.list.map((item, i) => {
                  const unsupported = /\.(?:svg|gif)(?:[?#]|$)/i.test(item.url);
                  const done = imported.includes(item.url);
                  return (
                    <div className="bo-candidate" key={`${item.url}:${i}`}>
                      <span className="bo-candidate-name">{item.alt || (group.logo ? "Logo" : "Brand image")}<span className="gx-hint bo-url">{item.url}</span>{unsupported ? <span className="gx-hint">Upload a PNG, JPEG, WebP or AVIF version instead.</span> : null}</span>
                      <button type="button" className="gx-hbtn" disabled={Boolean(work.busy) || unsupported || done} onClick={() => void importImage(item.url, group.logo)}>
                        {done ? "Imported" : work.busy === item.url ? "Importing…" : group.logo ? "Import the logo" : "Import"}
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null)}
          </div>
        ) : null}
      </section>

      <section className="gx-gen-card" aria-label="Brand kit" data-testid="brand-kit">
        <CardHead label="Brand kit"><span className="gx-hint" data-testid="brand-source">{kit.source ? `Reviewed from ${hostOf(kit.source.url)}` : "Written by hand"}</span></CardHead>
        <Field label="Brand name"><input className="gx-field" value={kit.name} maxLength={200} placeholder="The brand or studio" onChange={(e) => setKit({ name: e.target.value })} data-testid="brand-name" /></Field>
        <Field label="Tagline"><input className="gx-field" value={kit.tagline} maxLength={300} placeholder="The promise people remember" onChange={(e) => setKit({ tagline: e.target.value })} data-testid="brand-tagline" /></Field>
        <Field label="What the brand offers"><textarea className="gx-textarea bo-short" value={kit.description ?? ""} maxLength={4000} placeholder="Approved facts about the brand and what it offers" onChange={(e) => setKit({ description: e.target.value })} /></Field>
        <Field label="Voice"><textarea className="gx-textarea bo-short" value={kit.voice} maxLength={2000} placeholder="How it speaks, and what it never sounds like" onChange={(e) => setKit({ voice: e.target.value })} data-testid="brand-voice" /></Field>
        <Field label="Audience"><textarea className="gx-textarea bo-short" value={kit.audience} maxLength={2000} placeholder="Who it is for, and what matters to them" onChange={(e) => setKit({ audience: e.target.value })} /></Field>
        <div className="bo-row">
          <span className="bo-field-label" data-functional-label="">Typography</span>
          <div className="gx-chips" role="group" aria-label="Typography" data-testid="brand-font">
            {/* Sans faces in the Suites; a kit already set to the editorial face shows it until it is changed. */}
            {FONTS.filter(([id]) => id !== "editorial" || kit.font === "editorial").map(([id, label]) => <button key={id} type="button" className="gx-chip" aria-pressed={kit.font === id} onClick={() => setKit({ font: id })}>{label}</button>)}
          </div>
          {kit.fontFamilies?.length ? <p className="gx-hint">Typefaces on record: {kit.fontFamilies.join(" · ")}</p> : null}
        </div>
        <div className="bo-row" data-testid="brand-logo">
          <span className="bo-field-label" data-functional-label="">Logo</span>
          <div className="bo-slot">
            {logo ? <span className="bo-thumb"><LazyMedia url={logo.url} kind="image" alt="" name={logo.name} className="gx-lazy" /></span> : null}
            <span className="bo-slot-name" data-testid="brand-logo-name">{logo ? logo.name : "No logo yet"}</span>
            <button type="button" className="gx-hbtn" aria-expanded={logoOpen} disabled={Boolean(work.busy)} onClick={() => setLogoOpen(!logoOpen)} data-testid="brand-logo-choose">{logo ? "Change" : "Choose"}</button>
            {logo ? <button type="button" className="gx-hbtn" onClick={() => setKit({ logoAssetId: undefined })}>Remove</button> : null}
          </div>
          {logoOpen ? <PicturePicker items={items} label="Logo pictures" chosen={logo ? [logo.uploadId ?? logo.generationId ?? logo.id] : []} busy={work.busy === "logo"} onPick={takeLogo} onUpload={(f) => void uploadLogo(f)} testId="brand-logo-picker" /> : null}
        </div>
        <div className="bo-row" data-testid="brand-colors">
          <span className="bo-field-label" data-functional-label="">Palette · {colors.length} of {OWN_LIMITS.colors}</span>
          <div className="bo-swatches">
            {colors.map((color, i) => (
              <span className="bo-swatch" key={i}>
                <input type="color" aria-label={`Brand colour ${i + 1}`} value={HEX.test(color) ? color : "#000000"} onChange={(e) => setKit({ colors: colors.map((c, j) => (j === i ? e.target.value : c)) })} />
                <span className="bo-mono">{color.toUpperCase()}</span>
                <button type="button" className="gx-hbtn" aria-label={`Remove brand colour ${i + 1}`} onClick={() => setKit({ colors: colors.filter((_, j) => j !== i) })}>×</button>
              </span>
            ))}
            {colors.length < OWN_LIMITS.colors ? <button type="button" className="gx-hbtn" onClick={() => setKit({ colors: [...colors, "#0A84FF"] })} data-testid="brand-add-color">+ Colour</button> : null}
          </div>
        </div>
      </section>
      <SaveLine editor={editor} testId="brand-save" />
    </div>
  );
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "the website"; }
}
