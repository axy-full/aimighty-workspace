import { publicPageMetadata } from "@/lib/site";

/* The page is a client component and cannot export metadata; this segment does. */
export const metadata = publicPageMetadata("Report content", "Report something made with Particl.");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
