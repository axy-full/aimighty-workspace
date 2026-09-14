import { Suspense } from "react";
import GenWorkspace from "@/components/make/GenWorkspace";
import GenLoading from "@/components/make/GenLoading";

export const metadata = { title: "Gen · Particl" };

export default function GeneratePage() {
  return (
    <Suspense fallback={<GenLoading />}>
      <GenWorkspace />
    </Suspense>
  );
}
