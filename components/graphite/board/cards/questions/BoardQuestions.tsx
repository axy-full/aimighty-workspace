"use client";
import { useState } from "react";
import { useRig } from "@/components/workspace/rig/RigProvider";
import { useShowMeLooks } from "../looks/use-looks";
import { QuestionsBlock } from "./QuestionsBlock";
import { NO_ANSWERS, type Answers } from "./model";

/**
 * Atomik's questions before the looks, ready for the docked panel to mount on the open board (lead decision 29):
 * it reads the board's own draft and saves through its seam, so the panel passes nothing but why it is read-only
 * (offline, or the sample production). **Show me looks · N cr** is pressed by a person at the server's price, on
 * the path every still takes; **Use your judgement** is free and only fills the defaults. Atomik never presses it.
 */
export function BoardQuestions({ readOnly = null, onLooksSent }: { readOnly?: string | null; onLooksSent?: (count: number) => void }) {
  const rig = useRig();
  const [answers, setAnswers] = useState<Answers>(NO_ANSWERS);
  const looks = useShowMeLooks({ scope: rig.scope, project: rig.project, apply: rig.apply, save: rig.save }, answers, readOnly);
  if (!rig.project) return null;
  return (
    <QuestionsBlock
      project={rig.project} answers={answers} onAnswers={setAnswers} readOnly={readOnly}
      showLooks={{
        price: looks.price, pricing: looks.pricing, blocked: looks.blocked, busy: looks.busy, onTryAgain: looks.tryAgain,
        onPress: () => { void looks.send().then((n) => { if (n) onLooksSent?.(n); }); },
      }}
    />
  );
}
