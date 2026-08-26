"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useProject } from "@/lib/projectContext";

/** Legacy bin deep-link: select that project globally, then go compose. */
export default function LegacyBinRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { setSelection } = useProject();
  useEffect(() => {
    setSelection(id);
    router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once
  }, []);
  return null;
}
