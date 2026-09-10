import { redirect } from "next/navigation";

/** Old links to /generate open Make (§10). */
export default function Moved() {
  redirect("/make/video");
}
