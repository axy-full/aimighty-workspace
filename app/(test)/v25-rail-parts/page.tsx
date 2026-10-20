import { notFound } from "next/navigation";
import { V25RailParts } from "@/components/v12/dev/V25RailParts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Particl", robots: { index: false, follow: false } };

/**
 * Test only: the v25 stepper rail in a frame as tall as the board's canvas, for tests/rail-v25-workbench.spec.ts and the screenshots beside
 * design/particl-prototype-25. Like app/(test)/v12-primitives, it exists only on a local ENGINE_MOCK=1 development server; in a production build,
 * or without the mock, it is a 404.
 */
export default function V25RailPartsPage() {
  if (process.env.ENGINE_MOCK !== "1" || process.env.NODE_ENV === "production") notFound();
  return <V25RailParts />;
}
