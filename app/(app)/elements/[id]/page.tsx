"use client";

import { use } from "react";
import { usePageTitle } from "@/lib/usePageTitle";
import ElementScreen from "@/components/ElementScreen";

/** One element's ports (brief 3, surface 2b). */
export default function ElementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Element");
  return <ElementScreen elementId={id} />;
}
