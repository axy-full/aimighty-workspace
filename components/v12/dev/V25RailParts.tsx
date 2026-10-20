"use client";
import { useState } from "react";
import { OverlayProvider, ToastProvider } from "../ui";
import { StepRail, type RailStep } from "../board/StepRail";
import { railIcon } from "../board/rail-icons";
import "../v12.css";
import "./v25-parts.css";

/**
 * Test only (app/(test)/v25-rail-parts, a 404 outside a local mock server): the v25 stepper rail, in a frame as tall as the board's canvas, for the
 * screenshots beside design/particl-prototype-25 and tests/rail-v25-workbench.spec.ts. EVERYTHING HERE IS MOCK DATA: the steps and their statuses
 * stand for what the board screen will pass in when it is built; nothing is read from a workspace.
 */
const step = (id: string, label: string, status: string, extra: Partial<RailStep> = {}): RailStep => ({ id, label, icon: railIcon(id), status, ...extra });

const FILM: RailStep[] = [
  step("pitch", "Treatment", "Done", { done: true, optional: true }),
  step("brief", "Brief", "Done", { done: true }),
  step("script", "Script", "Done", { done: true }),
  step("cast", "Cast", "Done", { done: true }),
  step("locations", "Locations", "Done", { done: true }),
  step("elements", "Elements", "Done", { done: true }),
  step("storyboard", "Storyboard", "Done", { done: true }),
  step("shots", "Shots", "3 of 8 ready · 1 in work"),
  step("edit", "Edit", "Not started"),
  step("deliver", "Deliver", "Not started"),
];
const CLIPS: RailStep[] = [
  step("source", "Source", "Done", { done: true }),
  step("moments", "Moments", "6 moments found"),
  step("clips", "Clips", "Not started"),
  step("captions", "Captions", "Not started"),
  step("deliver", "Deliver", "Not started"),
];
const MANY: RailStep[] = [
  ...FILM.slice(0, 7),
  step("pitchdeck", "A long step name that cannot fit", "Not started"),
  ...["look", "formats", "variants", "hook", "voice", "captions", "moments"].map((id) => step(id, id[0].toUpperCase() + id.slice(1), "Not started")),
];
const POOL = ["moments", "captions", "hook", "look", "formats"];

function Frame({ label, initial, current, tall, addable }: { label: string; initial: RailStep[]; current: string; tall?: boolean; addable?: boolean }) {
  const [steps, setSteps] = useState(initial);
  const [now, setNow] = useState(current);
  const add = () => {
    const id = POOL.find((p) => !steps.some((s) => s.id === p));
    if (id) setSteps((s) => [...s, step(id, id[0].toUpperCase() + id.slice(1), "Not started")]);
  };
  return (
    <section className="v25-parts-frame" data-tall={tall ? "" : undefined} aria-label={label} data-testid={`v25-rail-${label.toLowerCase().replace(/\W+/g, "-")}`}>
      <StepRail steps={steps} current={now} onPick={setNow} onAdd={addable ? add : undefined} />
      <p className="v25-parts-said" data-testid="v25-rail-now">{now}</p>
    </section>
  );
}

export function V25RailParts() {
  return (
    <OverlayProvider>
      <ToastProvider bottom={24}>
        <div className="v12 v25-parts">
          <div className="v25-parts-head" aria-hidden="true">The board&apos;s two header rows stand here (mock)</div>
          <Frame label="Film" initial={FILM} current="shots" tall addable />
          <h1 className="v25-parts-h">Rail · five steps (Social clips) · fifteen steps, which scroll (mock data)</h1>
          <div className="v25-parts-pair">
            <Frame label="Clips" initial={CLIPS} current="moments" />
            <Frame label="Many" initial={MANY} current="look" />
          </div>
        </div>
      </ToastProvider>
    </OverlayProvider>
  );
}
