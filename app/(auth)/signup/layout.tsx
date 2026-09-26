import { publicPageMetadata } from "@/lib/site";

/* The page is a client component and cannot export metadata; this segment does. */
export const metadata = publicPageMetadata("Create your workspace", "Create a Particl workspace for your production team.");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
