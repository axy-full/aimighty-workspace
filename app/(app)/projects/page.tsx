"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** The Bins page folded into the title-bar project switcher. */
export default function LegacyBinsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/"); }, [router]);
  return null;
}
