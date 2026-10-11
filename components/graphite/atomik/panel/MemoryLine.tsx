"use client";
import { useEffect, useState } from "react";
import { useSession } from "@/lib/session";
import { useMemoryApi, type ForgetFind } from "@/lib/shell/use-memory";
import { MEMORY_KIND_LABEL, MONEY_REFUSAL, TEXT_KINDS, guessKind, mentionsMoney, type MemoryKind } from "@/lib/atomikMemoryText";

/**
 * "remember …" and "forget …" typed to Atomik (lib/atomikMemoryText.ts › parseMemoryCommand), as the Agent page
 * handled them: a person confirms what is kept, or which entries are archived (nothing is erased). Free: no quote,
 * no model call. Amounts of money are never kept.
 */
export function MemoryLine({ verb, subject, productionId, onDone, onCancel }: {
  verb: "remember" | "forget"; subject: string; productionId: string | null;
  onDone: (said: string) => void; onCancel: () => void;
}) {
  const api = useMemoryApi(useSession().requestScope);
  const [kind, setKind] = useState<MemoryKind>(() => guessKind(subject));
  const [where, setWhere] = useState<"project" | "workspace">(productionId ? "project" : "workspace");
  const [find, setFind] = useState<ForgetFind | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [working, setWorking] = useState(verb === "forget");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (verb !== "forget") return;
    let live = true;
    api.find(`forget ${subject}`, productionId)
      .then((found) => { if (live) { setFind(found); setPicked(found.matches.filter((m) => m.selected).map((m) => m.id)); } })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : "Memory could not be read. Try again."); })
      .finally(() => { if (live) setWorking(false); });
    return () => { live = false; };
  }, [api, productionId, subject, verb]);

  if (verb === "forget") {
    const forget = async () => {
      setWorking(true);
      setError(null);
      try {
        const n = await api.forget(picked);
        onDone(`Forgot ${n} ${n === 1 ? "entry" : "entries"}. A copy of each stays in the workspace archive.`);
      } catch (e) { setError(e instanceof Error ? e.message : "Those entries could not be forgotten. Try again."); setWorking(false); }
    };
    return (
      <section className="ak-card" aria-label="Forget from memory" data-testid="atomik-forget">
        <strong className="ak-card-title">Forget “{subject}”</strong>
        {working && !find ? <p className="ak-line" role="status">Looking through memory…</p> : null}
        {find && find.matches.length ? (
          <div className="ak-picks">
            {find.matches.map((m) => (
              <label key={m.id} className="ak-pick">
                <input type="checkbox" checked={picked.includes(m.id)} disabled={working}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, m.id] : picked.filter((id) => id !== m.id))} />
                <span><em>{MEMORY_KIND_LABEL[m.kind]}{m.scope === "project" ? " · this project" : ""}</em> {m.assetLabel ?? ""} {m.text}</span>
              </label>
            ))}
          </div>
        ) : find ? <p className="ak-line">Nothing in memory matches “{find.subject}”.</p> : null}
        {error ? <p className="ak-line ak-problem" role="alert">{error}</p> : null}
        <div className="ak-actions">
          <button type="button" className="ak-btn" disabled={working && !!find} onClick={onCancel}>{find && !find.matches.length ? "Close" : "Cancel"}</button>
          {find?.matches.length ? <button type="button" className="ak-btn ak-btn-primary" disabled={!picked.length || working} onClick={() => void forget()} data-testid="atomik-forget-confirm">{working ? "Forgetting…" : `Forget ${picked.length}`}</button> : null}
        </div>
      </section>
    );
  }

  const money = mentionsMoney(subject);
  const save = async () => {
    setWorking(true);
    setError(null);
    try {
      await api.add({ kind, text: subject, projectId: where === "project" ? productionId : null, source: "person" });
      onDone("Atomik will remember that.");
    } catch (e) { setError(e instanceof Error ? e.message : "That could not be saved. Try again."); setWorking(false); }
  };
  return (
    <section className="ak-card" aria-label="Remember" data-testid="atomik-remember">
      <strong className="ak-card-title">Remember</strong>
      <p className="ak-line">{subject}</p>
      <div className="ak-chips" role="group" aria-label="What it is">
        {TEXT_KINDS.map((k) => <button key={k} type="button" className="ak-chip" aria-pressed={kind === k} onClick={() => setKind(k)}>{MEMORY_KIND_LABEL[k]}</button>)}
      </div>
      <div className="ak-chips" role="group" aria-label="Where it applies">
        <button type="button" className="ak-chip" aria-pressed={where === "project"} disabled={!productionId} onClick={() => setWhere("project")}>This project</button>
        <button type="button" className="ak-chip" aria-pressed={where === "workspace"} onClick={() => setWhere("workspace")}>Whole workspace</button>
      </div>
      {money ? <p className="ak-line ak-problem" role="alert">{MONEY_REFUSAL}</p> : null}
      {error ? <p className="ak-line ak-problem" role="alert">{error}</p> : null}
      <div className="ak-actions">
        <button type="button" className="ak-btn" disabled={working} onClick={onCancel}>Cancel</button>
        <button type="button" className="ak-btn ak-btn-primary" disabled={money || working} onClick={() => void save()} data-testid="atomik-remember-save">{working ? "Saving…" : "Remember · free"}</button>
      </div>
    </section>
  );
}
