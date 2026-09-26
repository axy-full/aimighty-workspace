"use client";

import type { Ref } from "react";
import { useAtomik } from "./AtomikProvider";
import { CheckpointCard } from "./AtomikSheet";
import { ChatComposer } from "./ChatComposer";
import Ring from "./Ring";
import { Mono } from "@/components/ui";

/**
 * The Atomik conversation in a page, for a shell with no Atomik rail (the
 * Suites Atomik suite): what Atomik last said, the one card that moves the
 * run — a priced checkpoint, a question, or what it is doing — and the
 * composer. Same provider, same routes and the same claim-then-render gate
 * as the rail; nothing here spends without Continue.
 */
export function AtomikInline({ inputRef }: { inputRef?: Ref<HTMLInputElement> }) {
  const a = useAtomik();
  const said = [...a.messages].reverse().find((m) => m.role === "assistant") ?? null;
  const done = a.plan.filter((s) => s.status === "done").length;
  const context = [a.chat?.title, a.plan.length ? `${done} of ${a.plan.length}` : null].filter(Boolean).join(" · ");
  return (
    <section className="flex min-w-0 flex-col gap-[12px]" aria-label="Atomik conversation" data-testid="atomik-inline">
      <header className="flex min-w-0 items-center gap-[8px]">
        {"steps" in a.ring ? <Ring steps={a.ring.steps} size={18} /> : <Ring mode={a.ring.mode} size={18} />}
        <span className="text-[14px] font-semibold leading-none text-ink">Atomik</span>
        {context && <Mono className="min-w-0 truncate">{context}</Mono>}
      </header>
      {said?.text && <p className="m-0 text-[13.5px] leading-[1.45] text-ink-body" style={{ textWrap: "pretty", overflowWrap: "anywhere" }}>{said.text}</p>}
      <CheckpointCard />
      {a.error && <p role="alert" className="m-0 text-[12.5px] leading-[1.45] text-ink-body">{a.error}</p>}
      <ChatComposer inputHeight={48} inputRef={inputRef} />
    </section>
  );
}
