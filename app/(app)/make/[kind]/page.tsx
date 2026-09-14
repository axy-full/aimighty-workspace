import { Suspense } from "react";
import { notFound } from "next/navigation";
import GenWorkspace from "@/components/make/GenWorkspace";
import GenLoading from "@/components/make/GenLoading";

export const metadata = { title: "Gen · Particl" };

/** Existing links retain all query parameters and open the same Gen workspace. */
export default async function MakePage({
  params,
}: {
  params: Promise<{ kind: string }>;
}) {
  const { kind } = await params;
  if (!["video", "images", "audio"].includes(kind)) notFound();
  return (
    <Suspense fallback={<GenLoading />}>
      <GenWorkspace initialKind={kind} />
    </Suspense>
  );
}
