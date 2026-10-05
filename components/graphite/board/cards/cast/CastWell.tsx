import LazyMedia from "@/components/LazyMedia";
import type { CastCardData } from "./cast-model";
import "./cast.css";

/** The picture well of a Cast, Environment or Element card (and its Inspector's preview). */
export function CastWell({ still, name }: { still: CastCardData["still"]; name: string }) {
  return (
    <span className="gx-cast-well">
      {still ? <LazyMedia url={still.url} kind={still.kind} alt="" name={name} preview={false} /> : <span className="gx-cast-face" aria-hidden="true" />}
    </span>
  );
}

