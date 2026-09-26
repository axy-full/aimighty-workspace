import { publicPageMetadata } from "@/lib/site";

/* The page is a client component and cannot export metadata; this segment does. */
export const metadata = publicPageMetadata("Terms", "The terms for Particl accounts, workspaces, credits and plans.");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
