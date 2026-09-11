import { redirect } from "next/navigation";

/** The Library's Unfiled lens is where every unfiled take lives now (§11). */
export default function Moved() {
  redirect("/library?view=unfiled");
}
