import { notFound } from "next/navigation";
import { JoinGallery } from "@/components/v12/dev/JoinGallery";

export const dynamic = "force-dynamic";
export const metadata = { title: "Particl", robots: { index: false, follow: false } };

/**
 * Test only: the join sheet on its own (`?join=start|make|…&requested=1&prompt=…&phone=1`), for
 * tests/join-v12-workbench.spec.ts until the visitor screens that open it land. Guarded like app/(test)/v12-primitives:
 * a 404 in a production build or without ENGINE_MOCK=1.
 */
export default function V12Join() {
  if (process.env.ENGINE_MOCK !== "1" || process.env.NODE_ENV === "production") notFound();
  return <JoinGallery />;
}
