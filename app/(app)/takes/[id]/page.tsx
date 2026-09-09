"use client";

import { use } from "react";
import { usePageTitle } from "@/lib/usePageTitle";
import ProvenanceCard from "@/components/ProvenanceCard";

/** What produced one take (brief 3, surface 1c). */
export default function TakePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Take");
  return <ProvenanceCard takeId={id} />;
}
