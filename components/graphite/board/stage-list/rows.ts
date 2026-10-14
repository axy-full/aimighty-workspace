import type { BoardCard, CardState } from "@/lib/board/types";
import { PLATFORM_NAME, stateLine, type SocialPost } from "@/lib/social/posts";
import type { DocData } from "../cards/plan/derive";
import type { CastCardData } from "../cards/cast/cast-model";
import { VARIANT_LABEL } from "../cards/cast/cast-model";
import { deliverRows, secondsWords, type CutCardData } from "../cards/cut/cut-model";
import type { LookData } from "../cards/looks/derive";
import type { NextData } from "../cards/plan/NextCard";
import type { TakeCardData } from "../cards/take/shots-derive";
import { shotListState } from "../cards/take/take-model";
import type { FrameData } from "../cards/plan/derive";
import type { BrandData, FormatsData, HooksData, ImageAdData, ProductData, ReferenceData, ResultData, UnavailableData } from "../ads/ads-model";
import type { EffectsData, SourceData, UnavailableData as SocialUnavailableData } from "../social/social-model";
import { clock } from "../social/social-model";
import type { RoundCardData } from "@/components/v12/rounds/round-derive";

/*
 * A stage's List (owner, 13 Oct: "one board, four lenses"): the stage's OWN content as rows, the same cards the Canvas draws, so the two never disagree about what is
 * there. The beat table stays for Script, Storyboard and Shots; every other stage lists what it holds: the brief's fields, the cast and the elements, the cut's clips, the
 * delivery's specs, a campaign's hooks and ads, a social board's sources and posts. A row is the List's existing row (components/graphite/board/cards/board/ShotList.tsx):
 * # · what it is · its words · more · state. Pure: no React.
 */
export type RowTone = "green" | "gold" | "red" | "floor";
export type StageRow = {
  /** Unique within the list. */
  id: string;
  /** The card this row selects on the board, or null. */
  cardId: string | null;
  /** The short word for what it is: "Hook", "Clip", "Spec". */
  kind: string;
  title: string;
  detail: string;
  more: string;
  state: string;
  tone: RowTone;
};

const STATE: Record<CardState, [string, RowTone]> = { needs: ["Needs you", "gold"], working: ["Working", "gold"], done: ["Done", "green"], empty: ["Waiting", "floor"] };
const SHOT_TONE = { done: "green", waiting: "gold", live: "gold", idle: "floor", failed: "red" } as const;
const one = (text: string | null | undefined, max = 140): string => {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const named = (kind: string): string => kind.replace(/^(ads|social)-/, "").replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

type Options = {
  /** The social board's posts (a post card names one by id). */
  posts?: readonly SocialPost[];
  now?: number;
};

export function stageRows(cards: readonly BoardCard[], { posts = [], now = 0 }: Options = {}): StageRow[] {
  const rows: StageRow[] = [];
  for (const card of cards) {
    const [word, tone] = STATE[card.state];
    const base = { cardId: card.id, state: word, tone } as const;
    const add = (key: string, kind: string, title: string, detail = "", more = "", over: Partial<Pick<StageRow, "state" | "tone">> = {}) =>
      rows.push({ id: `${card.id}#${key}`, ...base, kind, title, detail, more, ...over });
    switch (card.kind) {
      case "group": break;
      case "doc": {
        const d = card.data as DocData;
        if (d.variant === "brief") {
          if (one(d.doc.brief)) add("brief", "Brief", "What we are making", one(d.doc.brief));
          if (one(d.doc.look)) add("look", "Brief", "Look", one(d.doc.look));
          if (d.doc.footer) add("format", "Brief", "Format", d.doc.footer);
          if (!rows.some((r) => r.cardId === card.id)) add("brief", "Brief", d.doc.title || "Brief");
        } else if (d.variant === "script") add("script", "Script", "Script", one(d.text));
        else if (d.variant === "beat") add("beat", "Beat", d.title, one(d.text));
        else add("doc", "Brief", d.title || "Brief", one(d.text));
        break;
      }
      case "look": {
        const d = card.data as LookData;
        add("look", "Look", d.name, d.meta, "", d.picked ? { state: "Picked", tone: "green" } : d.rendering ? { state: "Rendering", tone: "gold" } : {});
        break;
      }
      case "cast": {
        const d = card.data as CastCardData;
        add("cast", VARIANT_LABEL[d.variant] ?? "Cast", d.title, one(d.description), d.shots.length ? `Shot${d.shots.length === 1 ? "" : "s"} ${d.shots.join(", ")}` : "");
        break;
      }
      case "cut": {
        const { cut } = card.data as CutCardData;
        cut.clips.forEach((clip) => add(`clip-${clip.id}`, "Clip", clip.label, secondsWords(clip.seconds), clip.shot ? `Shot ${clip.shot}` : "", clip.approved ? { state: "Approved", tone: "green" } : { state: "Not approved", tone: "floor" }));
        cut.waiting.forEach((w) => add(`waiting-${w.shot}`, "Shot", `Shot ${w.shot}`, "Not in the cut", w.word, { state: "Waiting", tone: "floor" }));
        if (!cut.clips.length && !cut.waiting.length) add("cut", "Cut", "The cut", card.summary ?? "");
        break;
      }
      case "deliver": {
        const { cut } = card.data as CutCardData;
        for (const spec of deliverRows(cut)) {
          const mark = spec.mark === "ok" ? ["Ready", "green"] as const : spec.mark === "fail" ? ["Check", "red"] as const : spec.mark === "pending" ? ["Waiting on the cut", "floor"] as const : ["", "floor"] as const;
          add(`spec-${spec.key}`, "Spec", spec.label, spec.value, spec.word ?? "", { state: mark[0], tone: mark[1] });
        }
        break;
      }
      case "next": {
        const d = card.data as NextData;
        add("next", "Next", d.name, d.line);
        break;
      }
      case "take": {
        const { row } = card.data as TakeCardData;
        const s = shotListState(row);
        add("take", "Shot", row.title, row.line, `${row.versions.length} ${row.versions.length === 1 ? "take" : "takes"}`, s ? { state: s.word, tone: SHOT_TONE[s.tone] } : { state: "No take yet", tone: "floor" });
        break;
      }
      case "frame": {
        const d = card.data as FrameData;
        add("frame", "Frame", d.name || `Shot ${d.index}`, d.line, "", { state: d.rendering ? "Drawing" : d.genId ? "Storyboarded" : "No frame yet", tone: d.rendering ? "gold" : d.genId ? "green" : "floor" });
        break;
      }
      case "round": {
        const d = card.data as RoundCardData;
        add("round", "Round", `Round ${d.round.n}`, `${d.round.changes.length} ${d.round.changes.length === 1 ? "change" : "changes"}`, d.board);
        break;
      }
      case "ads-brand": { const d = card.data as BrandData; add("brand", "Brand", d.name || "Brand", one([d.host, d.tone].filter(Boolean).join(" · ")), d.colors.slice(0, 4).join(" ")); break; }
      case "ads-product": { const d = card.data as ProductData; add("product", "Product", d.name || "Product", one(d.facts), d.brand); break; }
      case "ads-reference": { const d = card.data as ReferenceData; add("reference", "Reference", d.name || "Reference ad", d.rows.map((r) => `${r.label} ${r.value}`).join(" · "), `${d.videos} ${d.videos === 1 ? "video" : "videos"}`); break; }
      case "ads-hooks": {
        const d = card.data as HooksData;
        d.lines.forEach((line, i) => add(`hook-${i}`, "Hook", one(line), "", "", d.picked.includes(line) ? { state: "Picked", tone: "green" } : { state: "Hook", tone: "floor" }));
        d.proposed.forEach((line, i) => add(`proposed-${i}`, "Hook", one(line), "Proposed by Atomik", "", { state: "Proposed", tone: "gold" }));
        if (!d.lines.length && !d.proposed.length) add("hooks", "Hook", "No hooks yet");
        break;
      }
      case "ads-formats": {
        const d = card.data as FormatsData;
        for (const f of d.formats) add(`format-${f.id}`, "Format", f.label, f.briefs.map((b) => `${b.name} ${b.aspect}`).join(" · "), `${f.briefs.length} ${f.briefs.length === 1 ? "brief" : "briefs"}`, d.chosen === f.id ? { state: "Chosen", tone: "green" } : { state: "Format", tone: "floor" });
        if (!d.formats.length) add("formats", "Format", "No formats yet");
        break;
      }
      case "ads-image": { const d = card.data as ImageAdData; add("image-ad", "Image ad", d.productName || "Image ad", one(d.hook), d.stillName ?? ""); break; }
      case "ads-result": {
        const d = card.data as ResultData;
        add("result", d.media === "video" ? "Video ad" : "Image ad", d.name, d.engine, d.review === "approved" ? "Approved" : d.status, d.failure ? { state: "Failed", tone: "red" } : d.review === "approved" ? { state: "Approved", tone: "green" } : {});
        break;
      }
      case "ads-unavailable": case "social-unavailable": { const d = card.data as UnavailableData | SocialUnavailableData; add("unavailable", "Not yet", d.title, d.line, "", { state: "Not in Particl yet", tone: "floor" }); break; }
      case "social-source": { const d = card.data as SourceData; add("source", "Source", d.name, clock(d.seconds), d.fits ? "Fits the quick tools" : ""); break; }
      case "social-effects": { const d = card.data as EffectsData; add("effects", "Effects", "Motion transfer · Object swap", `${d.sources} ${d.sources === 1 ? "source" : "sources"}`); break; }
      case "social-post": {
        const post = posts.find((p) => p.id === (card.data as { id: string }).id);
        if (post) add("post", "Post", `${PLATFORM_NAME[post.platform]} · ${post.format}`, post.clip, post.aspect, { state: stateLine(post, now), tone: post.state === "posted" ? "green" : post.state === "failed" ? "red" : post.state === "draft" ? "floor" : "gold" });
        else add("post", "Post", "Post");
        break;
      }
      case "note": { const d = card.data as { text?: string }; add("note", "Note", one(d.text) || "Note", "", "", { state: "", tone: "floor" }); break; }
      case "label": { const d = card.data as { title?: string }; add("label", "Text", one(d.title) || "Text", "", "", { state: "", tone: "floor" }); break; }
      default: {
        /* Any other card (a media card, a tool, a plan): what it is called, and the card's own one-line summary. */
        const d = (card.data ?? {}) as { title?: string; name?: string; kicker?: string; text?: string };
        add("card", d.kicker || named(card.kind), one(d.title || d.name) || named(card.kind), one(d.text) || card.summary || "");
      }
    }
  }
  return rows;
}

/** The stages whose List is the beat table (Script, Storyboard, Shots of a Film or Pre-vis board); every other stage lists its own cards. */
export const BEAT_TABLE_STAGES: readonly string[] = ["script", "storyboard", "shots"];
export const showsBeatTable = (stageId: string | null | undefined, flavor: string): boolean => (flavor === "film" || flavor === "previs") && !!stageId && BEAT_TABLE_STAGES.includes(stageId);
