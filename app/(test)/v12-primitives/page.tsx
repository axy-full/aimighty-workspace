import { notFound } from "next/navigation";
import { PrimitivesGallery } from "@/components/v12/dev/PrimitivesGallery";

export const dynamic = "force-dynamic";
export const metadata = { title: "Particl", robots: { index: false, follow: false } };

/**
 * Test only: every shared piece of the new interface on one page, for tests/primitives-v12-workbench.spec.ts. It
 * exists only on a local ENGINE_MOCK=1 development server, the same guard as the mocked delays (lib/mock.ts ›
 * mockDelayMs, app/api/uploads/finish): in a production build, or without the mock, it is a 404.
 */
export default function V12Primitives() {
  if (process.env.ENGINE_MOCK !== "1" || process.env.NODE_ENV === "production") notFound();
  return <PrimitivesGallery />;
}
