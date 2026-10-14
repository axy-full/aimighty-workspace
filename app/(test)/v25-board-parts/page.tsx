import { notFound } from "next/navigation";
import { V25CardParts } from "@/components/v12/dev/V25CardParts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Particl", robots: { index: false, follow: false } };

/**
 * Test only: the v25 card on a canvas like the board's, for tests/card-v25-workbench.spec.ts and the screenshots beside design/particl-prototype-25.
 * Like app/(test)/v12-primitives, it exists only on a local ENGINE_MOCK=1 development server; in a production build, or without the mock, it is a 404.
 */
export default function V25BoardParts() {
  if (process.env.ENGINE_MOCK !== "1" || process.env.NODE_ENV === "production") notFound();
  return <V25CardParts />;
}
