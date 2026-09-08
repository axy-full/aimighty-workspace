"use client";

import { use } from "react";
import { usePageTitle } from "@/lib/usePageTitle";
import ShotBindings from "@/components/ShotBindings";

/** One shot's five slots (brief 3, surface 2c). */
export default function ShotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Shot");
  return <ShotBindings shotId={id} />;
}
