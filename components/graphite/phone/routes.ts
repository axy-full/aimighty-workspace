import type { ScreenModule } from "@/lib/shell/screens";

/**
 * The phone (stream 10): its own screens at compact widths, or at any width with `device=phone` (a centred 390 px
 * frame). `screen`, `device`, `from`, `run` and `take` are its params. Seeded by the shell (stream 1); stream 10
 * owns this file from here and flips `landed` in the PR that completes the phone's set. The phone reads every
 * address itself, so it adds no rows.
 */
export const PHONE_SCREEN: ScreenModule = {
  id: "phone",
  landed: false,
  params: ["screen", "device", "from", "run", "take"],
  rows: [],
  fallback: [],
};
