"use client";
import { suiteHref } from "@/lib/suites";
import { EMPTY_MOLECULR, MOLECULR_FORMATS } from "@/lib/workbench/moleculr";
import type { Project } from "@/lib/workbench/studio";

type Link = { section: string; label: string };
const LINKS: Record<string, Link[]> = {
  product: [{ section: "product", label: "Open Product" }],
  brand: [{ section: "brand", label: "Open Brand" }, { section: "cast", label: "Open Cast" }],
  format: [{ section: "format", label: "Open Format" }],
  variants: [{ section: "variants", label: "Open Variants" }, { section: "design", label: "Open Design" }, { section: "publish", label: "Open Publish" }],
};

const n = (value: number) => value.toLocaleString("en-US");

/**
 * Marketing Studio's four areas as the saved project holds them, each opening
 * the existing Marketing Studio at that section. Its variant flow configures
 * generation nodes through Studio's generation dialog and draft engine, so it
 * runs there rather than in a second copy here.
 */
export default function MarketingTool({ tool, project }: { tool: string; project: Project }) {
  const brief = project.moleculr ?? EMPTY_MOLECULR;
  const rows: [string, string][] =
    tool === "product"
      ? [
          ["Product", brief.productName || "Not named yet"],
          ["Product URL", brief.productUrl || "None saved"],
          ["Product images", `${n(brief.productAssetIds.length)} of 5`],
          ["Saved products", n(brief.products?.length ?? 0)],
        ]
      : tool === "brand"
        ? [
            ["Brand kit", brief.brandKit?.name || "Not set"],
            ["Presenters", `${n(brief.castAssetIds.length)} of 6`],
          ]
        : tool === "format"
          ? [
              ["Format", MOLECULR_FORMATS.find((item) => item.id === brief.format)?.label ?? brief.format],
              ["Hooks", `${n(brief.hooks.length)} of 12`],
              ["Aspect", brief.creative?.aspect ?? "Not set"],
            ]
          : [
              ["Variants", `${n(brief.variants.length)} of 100`],
              ["Video variants", n(brief.variants.filter((item) => item.kind === "video").length)],
              ["Design", brief.poster ? "Saved" : "Not started"],
            ];
  return (
    <div className="pxw-tool pxw-tool--marketing" data-tool-body={tool}>
      <div className="pxw-package">
        <div className="pxw-package-facts">
          {rows.map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        {tool === "format" && brief.hooks.length ? (
          <ol className="pxw-hook-list">
            {brief.hooks.map((hook, i) => (
              <li key={i}>{hook}</li>
            ))}
          </ol>
        ) : null}
        <p className="pxw-package-note">Marketing Studio edits these on the project, binds each variant to your saved originals and prices it before it runs.</p>
        <div className="pxw-package-actions">
          {LINKS[tool].map((link, i) => (
            <a key={link.section} className={`pxw-btn ${i === 0 ? "pxw-btn--primary" : "pxw-btn--control"}`} href={suiteHref("moleculr", project.id, link.section)}>
              {link.label}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
