export type BrandEvidenceSource =
  | "json-ld"
  | "open-graph"
  | "html-title"
  | "html-meta"
  | "inline-css"
  | "html-image"
  | "html-link";

export type BrandImageCandidate = {
  url: string;
  source: BrandEvidenceSource;
  alt?: string;
};

/** Unverified page observations, never an imported asset or approved brand kit. */
export type BrandExtraction = {
  source: { requestedUrl: string; finalUrl: string; fetchedAt: string };
  brand: {
    name: string;
    description: string;
    tagline?: string;
    colors: string[];
    fontFamilies: string[];
    tone?: string;
  };
  logoCandidates: BrandImageCandidate[];
  imageryCandidates: BrandImageCandidate[];
  evidence: {
    field: "name" | "description" | "tagline" | "color" | "fontFamily" | "logo" | "image";
    source: BrandEvidenceSource;
    value: string;
    sourceUrl: string;
  }[];
  warnings: string[];
  requiresReview: true;
};
