import { redirect } from "next/navigation";

/** Make is the front door (design/particl-v2/README.md §1, §10): the old composer at `/` is gone; the address still opens Make. */
export default function Moved() {
  redirect("/make/video");
}
