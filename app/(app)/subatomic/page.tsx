import { Suspense } from "react";
import SubatomicSuite from "@/components/suites/SubatomicSuite";
export const metadata = { title: "Subatomic — Particl" };
export default function Page() {
  return (
    <Suspense fallback={<p role="status">Opening Subatomic…</p>}>
      <SubatomicSuite />
    </Suspense>
  );
}
