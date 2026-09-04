"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useApi } from "@/lib/useApi";
import { timeAgo } from "@/lib/format";
import { appConfirm } from "./dialog";
import { IconPlus } from "./Icons";
import type { Chat } from "@/lib/atomik";

/**
 * Atomik's conversations, in the column Particl uses for projects.
 *
 * The same rail rather than a second one: on this screen the unit of work
 * is a conversation, not a project, so the column shows conversations. The
 * project a chat files its renders into is chosen in the composer and
 * travels with the chat.
 *
 * A chat with something waiting behind the gate says so here, because the
 * whole point of an approval gate is that you can walk away from it — and
 * a gate you can walk away from needs somewhere to be remembered.
 */

type Row = Chat & { needsApproval: boolean };

export default function AtomikRail() {
  const router = useRouter();
  const params = useSearchParams();
  const current = params.get("c");

  const { data, refresh } = useApi<{ chats: Row[] }>("/api/atomik", 15_000);
  const chats = data?.chats ?? [];

  async function remove(c: Row) {
    const ok = await appConfirm(
      `Delete “${c.title}”?`,
      "The conversation goes. Anything it already rendered stays in the project — " +
      "those are ordinary renders now.",
      { confirmLabel: "Delete", danger: true },
    );
    if (!ok) return;
    await fetch(`/api/atomik/${encodeURIComponent(c.id)}`, { method: "DELETE" });
    if (current === c.id) router.replace("/atomik");
    refresh();
  }

  return (
    <aside className="rail" aria-label="Atomik chats">
      <div className="rail-head">
        <span className="grouplabel !pb-0">Chats</span>
        <button type="button" onClick={() => router.push("/atomik")}
          className="rail-new" title="New chat" aria-label="New chat">
          <IconPlus className="!h-3.5 !w-3.5" />
        </button>
      </div>

      <div className="rail-body">
        {chats.length === 0 && (
          <p className="px-3 py-2 text-[12.5px] leading-relaxed text-mute">
            Nothing yet. Describe a production and Atomik will work out the shots.
          </p>
        )}

        {chats.map((c) => (
          <div key={c.id} className="rail-group">
            <button type="button"
              onClick={() => router.push(`/atomik?c=${encodeURIComponent(c.id)}`)}
              onContextMenu={(e) => { e.preventDefault(); void remove(c); }}
              className={`rail-row ${current === c.id ? "is-on" : ""}`}
              title={`${c.title} · ${timeAgo(c.updatedAt)}`}>
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              {c.needsApproval && (
                <span className="rail-needs" title="Something is waiting for your approval">
                  Needs approval
                </span>
              )}
            </button>
          </div>
        ))}
      </div>

      <div className="rail-foot">
        <button type="button" onClick={() => router.push("/atomik")} className="rail-link">
          New chat
        </button>
      </div>
    </aside>
  );
}
