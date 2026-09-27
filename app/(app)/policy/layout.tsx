import { publicPageMetadata } from "@/lib/site";

/* The page is a client component and cannot export metadata; this segment does. */
export const metadata = publicPageMetadata("Content policy", "What may not be made with Particl, and what happens when it is.");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
