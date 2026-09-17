/** Review metadata only. Image candidates are not uploaded or approved assets. */
export type ProductEvidenceSource = "json-ld" | "open-graph" | "html-title";
export type ProductExtraction = {
  source: { requestedUrl: string; finalUrl: string; fetchedAt: string };
  product: { name: string; description: string; brand: string };
  evidence: {
    field: "name" | "description" | "brand" | "image";
    source: ProductEvidenceSource;
    value: string;
    sourceUrl: string;
  }[];
  imageCandidates: {
    url: string;
    source: "json-ld" | "open-graph";
    alt?: string;
  }[];
  warnings: string[];
  requiresReview: true;
};
