"use client";

import {
  Suspense,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUpRight, Megaphone } from "lucide-react";
import { useSession } from "@/lib/session";
import { setAtomikRail } from "@/lib/atomikRail";
import { suiteHref } from "@/lib/suites";
import { withPageLeaveGuard } from "@/lib/usePageLeaveGuard";
import styles from "./marketing-studio-entry.module.css";

const subscribePreference = (update: () => void) => {
  window.addEventListener("storage", update);
  return () => window.removeEventListener("storage", update);
};
const noPreference = () => "";

export default function MarketingStudioEntry() {
  return (
    <Suspense fallback={null}>
      <ProjectMarketingEntry />
    </Suspense>
  );
}

function ProjectMarketingEntry() {
  const { requestScope } = useSession();
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState(false);
  const remembered = useSyncExternalStore(
    subscribePreference,
    () => {
      try {
        return requestScope ? (localStorage.getItem(requestScope) ?? "") : "";
      } catch {
        return "";
      }
    },
    noPreference,
  );
  // The preference and query contain workbench draft IDs, not production IDs.
  const project = params.get("project") || remembered;
  const href = suiteHref("moleculr", project, "brand");
  function follow(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    setError(false);
    void withPageLeaveGuard(() => {
      setAtomikRail("closed");
      router.push(href);
    }).catch(() => setError(true));
  }
  return (
    <div className={styles.entry}>
      <Link
        href={href}
        prefetch={false}
        onClick={follow}
        className={styles.link}
        aria-label="Open Moleculr"
      >
        <span className={styles.icon}>
          <Megaphone size={18} strokeWidth={1.6} />
        </span>
        <span className={styles.copy}>
          <strong>Moleculr</strong>
          <span>Build a campaign with Atomik.</span>
        </span>
        <ArrowUpRight size={16} className={styles.arrow} aria-hidden="true" />
      </Link>
      {error && <p role="alert">Could not open Moleculr. Try again.</p>}
    </div>
  );
}
