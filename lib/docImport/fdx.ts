import { MAX_TEXT_CHARS } from "./limits";
import { DocImportError, type Deadline, type DocSection, type ExtractedDocument, type Warnings } from "./types";
import { attr, decodeXmlBytes, localName, scanXml } from "./xml";

/**
 * Final Draft (.fdx, and its template .fdxt) to Fountain, the internal script
 * format. Read with the DTD-free XML scanner in "refuse" mode: a Final Draft
 * file never declares a DOCTYPE, so one is a refusal, and no entity is ever
 * expanded.
 *
 * Only <FinalDraft><Content> is read: paragraphs by their Type (Scene
 * Heading, Action, Character, Parenthetical, Dialogue, Transition, Shot,
 * Lyrics, General...), dual dialogue, scene numbers, page breaks, centred
 * text, and bold / italic / underline runs. The title page, header and
 * footer, SmartType lists and revision data are not converted.
 */

type Paragraph = { type: string; text: string; number?: string; newPage: boolean; centered: boolean; dual: number };

const HEADING = /^(?:INT|EXT|EST|INT\.?\/EXT|INT\/EXT|I\/E)[.\s]/i;
const TRANSITION = /^[^a-z]*TO:$/;

/** Escape Fountain's emphasis characters so a script's own * and _ stay literal. */
const escapeInline = (text: string) => text.replace(/([\\*_])/g, "\\$1");

function styled(text: string, style: string): string {
  const escaped = escapeInline(text);
  // Index arithmetic, not a regex: a lazy pattern here backtracks quadratically on long runs of spaces.
  let from = 0;
  let to = escaped.length;
  while (from < to && /\s/.test(escaped[from])) from++;
  while (to > from && /\s/.test(escaped[to - 1])) to--;
  if (from === to) return escaped;
  const lead = escaped.slice(0, from);
  const core = escaped.slice(from, to);
  const trail = escaped.slice(to);
  const styles = style.split("+").map((value) => value.trim().toLowerCase());
  let wrapped = core;
  if (styles.includes("underline")) wrapped = `_${wrapped}_`;
  if (styles.includes("italic")) wrapped = `*${wrapped}*`;
  if (styles.includes("bold")) wrapped = `**${wrapped}**`;
  return lead + wrapped + trail;
}

const hasLetters = (text: string) => /\p{L}/u.test(text);
const allCaps = (text: string) => hasLetters(text) && text === text.toUpperCase();

/** An action line Fountain would read as something else gets the forced-action "!". */
function action(text: string): string {
  const first = text.split("\n")[0];
  const forced =
    /^[!@#~.>=^]/.test(first) || first.startsWith("[[") || first.startsWith("/*") ||
    HEADING.test(first) || allCaps(first);
  return forced ? "!" + text : text;
}

function toFountain(paragraphs: Paragraph[], warnings: Warnings): { text: string; sections: DocSection[] } {
  const blocks: { text: string; scene?: string }[] = [];
  let dialogue: string[] | null = null;
  const closeDialogue = () => {
    if (dialogue) blocks.push({ text: dialogue.join("\n") });
    dialogue = null;
  };
  for (const p of paragraphs) {
    if (p.newPage) {
      closeDialogue();
      blocks.push({ text: "===" });
    }
    const raw = p.text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
    const text = raw.trim();
    if (!text) continue;
    const type = p.type.toLowerCase();
    if (type === "character") {
      closeDialogue();
      // Lower case outside the extension "(V.O.)" means Fountain needs the forced "@".
      let name = /[a-z]/.test(text.slice(0, 500).replace(/\([^()]{0,100}\)/g, "")) ? "@" + text : text;
      if (p.dual === 2) name += " ^";
      dialogue = [name];
    } else if ((type === "dialogue" || type === "parenthetical") && dialogue) {
      const line = type === "parenthetical" && !text.startsWith("(") ? `(${text})` : text;
      // A blank line would end the dialogue; Fountain keeps it as two spaces.
      dialogue.push(...line.split("\n").map((value) => (value.trim() ? value : "  ")));
    } else {
      closeDialogue();
      if (type === "scene heading") {
        const number = p.number?.replace(/[^A-Za-z0-9.-]/g, "").slice(0, 10);
        const heading = (HEADING.test(text) ? text : "." + text.replace(/^\.+/, "")) + (number ? ` #${number}#` : "");
        blocks.push({ text: heading, scene: text });
      } else if (type === "transition") {
        blocks.push({ text: TRANSITION.test(text) ? text : `> ${text}` });
      } else if (type === "lyrics") {
        blocks.push({ text: text.split("\n").map((line) => `~${line}`).join("\n") });
      } else if (p.centered) {
        blocks.push({ text: text.split("\n").map((line) => `> ${line.trim()} <`).join("\n") });
      } else {
        if (type === "dialogue" || type === "parenthetical")
          warnings.add("Some dialogue had no character name before it; it was kept as action.");
        blocks.push({ text: action(text) });
      }
    }
  }
  closeDialogue();
  let text = "";
  const sections: DocSection[] = [];
  for (const block of blocks) {
    if (text) text += "\n\n";
    if (block.scene !== undefined) {
      const open = sections.at(-1);
      if (open) open.end = text.length - 2;
      sections.push({ kind: "scene", index: sections.length + 1, title: block.scene.slice(0, 200), start: text.length, end: 0 });
    }
    text += block.text;
  }
  const last = sections.at(-1);
  if (last) last.end = text.length;
  return { text: text ? text + "\n" : "", sections };
}

export async function extractFdx(bytes: Buffer, deadline: Deadline, warnings: Warnings): Promise<ExtractedDocument> {
  const label = "This Final Draft file";
  const source = decodeXmlBytes(bytes, label);
  const paragraphs: Paragraph[] = [];
  // Element path below the root; only FinalDraft > Content [> DualDialogue wrapper] > Paragraph is read.
  const path: string[] = [];
  const open: Paragraph[] = [];
  let dualDepth = 0;
  let dualCharacters = 0;
  let textStyle: string | null = null;
  const result = scanXml(source, (event) => {
    if (event.type === "open") {
      const name = localName(event.name);
      path.push(name);
      const inContent = path[0] === "FinalDraft" && path[1] === "Content";
      if (!inContent) return;
      if (name === "DualDialogue") {
        dualDepth++;
        dualCharacters = 0;
      } else if (name === "Paragraph") {
        const type = attr(event.attrs, "Type") ?? "Action";
        if (dualDepth && type === "Character") dualCharacters++;
        open.push({
          type,
          text: "",
          number: attr(event.attrs, "Number"),
          newPage: (attr(event.attrs, "StartsNewPage") ?? "").toLowerCase() === "yes",
          centered: (attr(event.attrs, "Alignment") ?? "").toLowerCase() === "center",
          dual: dualDepth && type === "Character" ? dualCharacters : 0,
        });
      } else if (name === "Text" && open.length && path.at(-2) === "Paragraph") textStyle = attr(event.attrs, "Style") ?? "";
      else if (name === "Tab" && open.length) open[open.length - 1].text += "\t";
    } else if (event.type === "close") {
      const name = path.pop();
      if (path[0] !== "FinalDraft" || path[1] !== "Content") return;
      if (name === "DualDialogue") dualDepth = Math.max(0, dualDepth - 1);
      else if (name === "Paragraph") {
        const done = open.pop();
        // A paragraph that only wraps others (the DualDialogue holder) has no text of its own.
        if (done && done.text) paragraphs.push(done);
      } else if (name === "Text") textStyle = null;
    } else if (textStyle !== null && open.length) {
      open[open.length - 1].text += styled(event.text, textStyle);
    }
  }, { doctype: "refuse", label, deadline });
  if (localName(result.root) !== "FinalDraft")
    throw new DocImportError("type_mismatch", "This file is named .fdx but it is not a Final Draft file. Nothing was imported.");
  if (result.unknownEntities)
    warnings.add(`${result.unknownEntities} unknown character references were kept as written.`);
  deadline.check();
  const { text, sections } = toFountain(paragraphs, warnings);
  if (text.length > MAX_TEXT_CHARS)
    throw new DocImportError("limit", "This script has more than one million characters of text. Nothing was imported.");
  if (!sections.length && text) warnings.add("This script has no scene headings.");
  return { kind: "fdx", format: "fountain", text, sections, images: [], warnings: [] };
}
