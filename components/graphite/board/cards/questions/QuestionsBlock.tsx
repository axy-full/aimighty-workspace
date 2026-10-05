"use client";
import { usePriceTitle } from "@/components/graphite/Price";
import { priceWords, type PriceValue } from "@/lib/shell/price-words";
import type { Project } from "@/lib/workbench/studio";
import { judgement, questionsFor, withChip, withWords, type Answers } from "./model";
import "./questions.css";

/** "Show me looks · N cr": its price from the server, and what pressing it does (the looks' own path). */
export type ShowLooks = {
  price: PriceValue | null;
  pricing: "none" | "loading" | "ready" | "error";
  /** Why it can't be pressed now (read-only, sending, nothing to make), or null. */
  blocked: string | null;
  busy: boolean;
  onPress: () => void;
  onTryAgain: () => void;
};

/**
 * Atomik's questions before the looks (design/particl-graphite/README.md § 3.1 b), as a form Atomik's panel mounts
 * (lead decision 29): each question with its chips and a field, then the primary **Show me looks · N cr** (paid,
 * pressed by a person at the server's price) and **Use your judgement** (free: it fills the defaults).
 */
export function QuestionsBlock({ project, answers, onAnswers, showLooks, readOnly, testId = "board-questions" }: {
  project: Project;
  answers: Answers;
  onAnswers: (answers: Answers) => void;
  showLooks: ShowLooks;
  readOnly: string | null;
  testId?: string;
}) {
  const questions = questionsFor(project);
  const title = usePriceTitle(showLooks.price);
  const words = showLooks.price ? priceWords(showLooks.price) : null;
  const blocked = readOnly ?? showLooks.blocked;
  return (
    <div className="gx-q" data-testid={testId}>
      {questions.map((q) => (
        <div key={q.id} className="gx-q-item" role="group" aria-label={q.text}>
          <span className="gx-q-text">{q.text}</span>
          <div className="gx-q-chips">
            {q.chips.map((c) => {
              const on = answers.chips[q.id] === c.id;
              return (
                <button key={c.id} type="button" className="gx-q-chip" aria-pressed={on} disabled={Boolean(readOnly)}
                  onClick={() => onAnswers(withChip(answers, q.id, c.id))}>{c.label}</button>
              );
            })}
          </div>
          <input className="gx-q-field" type="text" aria-label={`${q.text}: in your words`} placeholder={q.placeholder} maxLength={1000}
            value={answers.words[q.id] ?? ""} readOnly={Boolean(readOnly)} onChange={(e) => onAnswers(withWords(answers, q.id, e.target.value))} />
        </div>
      ))}
      <div className="gx-q-actions">
        {showLooks.pricing === "error" ? (
          <button type="button" className="gx-q-secondary" onClick={showLooks.onTryAgain} data-testid={`${testId}-try-again`}>Try again</button>
        ) : (
          <button type="button" className="gx-q-primary" title={title ?? undefined} disabled={Boolean(blocked) || !words || showLooks.busy}
            onClick={showLooks.onPress} data-testid={`${testId}-looks`}>
            {showLooks.busy ? "Sending looks…" : words ? `Show me looks · ${words}` : "Show me looks"}
          </button>
        )}
        <button type="button" className="gx-q-secondary" disabled={Boolean(readOnly)} onClick={() => onAnswers(judgement(project))} data-testid={`${testId}-judgement`}>
          Use your judgement
        </button>
        {blocked && !showLooks.busy ? <span className="gx-q-why" role="status">{blocked}</span> : null}
        {showLooks.pricing === "error" ? <span className="gx-q-why" role="status">The price could not be read.</span> : null}
      </div>
    </div>
  );
}
