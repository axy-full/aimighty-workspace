"use client";

/**
 * The way in is the composer.
 *
 * This used to be the Projects grid, on the reasoning that you pick a job
 * before you work on it. In practice the job is already in your head when you
 * open the tab — what you want is somewhere to type. Projects moved to
 * /projects, one tap away and still the second thing in the nav.
 */
import Workspace from "@/components/Workspace";

export default function HomePage() {
  return <Workspace />;
}
