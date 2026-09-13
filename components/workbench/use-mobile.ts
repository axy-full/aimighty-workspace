import { useSyncExternalStore } from "react";

const MOBILE_QUERY = "(max-width: 767px)";
const subscribe = (update: () => void) => {
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener("change", update);
  return () => query.removeEventListener("change", update);
};
const snapshot = () => window.matchMedia(MOBILE_QUERY).matches;
const serverSnapshot = () => false;

export function useIsMobile() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
