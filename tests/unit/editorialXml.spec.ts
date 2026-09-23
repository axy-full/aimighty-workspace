import { test, expect } from "@playwright/test";
import { escapeXml, makeFCPXML, makeXMEML, retimeProject } from "../../lib/workbench/editorial-xml";
import { assetFilename, newProject, type Asset, type Project } from "../../lib/workbench/studio";

/** Production › Delivery: the cut as FCPXML and Final Cut Pro 7 XML, beside the EDL. */
const asset = (id: string, kind: Asset["kind"], name: string, mime: string): Asset => ({ id, name, kind, mime, category: "Shot", url: `/api/media/${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] });

function project(): Project {
  const p = newProject("Fox & <Harbour>");
  return {
    ...p, fps: 24, aspect: "16:9",
    assets: [asset("gen-wide", "video", "Wide on the ice", "video/mp4"), asset("gen-still", "image", "Mara at the window", "image/png"), asset("up-voice", "audio", "Mara line", "audio/wav"), asset("up-score", "audio", "Score", "audio/mpeg")],
    shots: [
      { id: "s1", name: "01 — The crossing", assetId: "gen-wide", duration: 48, sourceIn: 12, note: "Hold on the ice" },
      { id: "s2", name: "02 — The window", assetId: "gen-still", duration: 72, sourceIn: 0, note: "" },
    ],
    audioClips: [
      { id: "c1", assetId: "up-voice", lane: "dialogue", startFrame: 60, sourceIn: 0, duration: 24, gainDb: -6, pan: 0, fadeIn: 0, fadeOut: 0, muted: false, solo: false },
      { id: "c2", assetId: "up-score", lane: "music", startFrame: 0, sourceIn: 24, duration: 120, gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0, muted: true, solo: false },
    ],
  };
}

/** A small well-formedness check: every open tag closes, in order; attributes are quoted. */
function wellFormed(xml: string): string[] {
  const body = xml.replace(/^<\?xml[^>]*\?>/, "").replace(/<!DOCTYPE[^>]*>/, "").replace(/<!--[\s\S]*?-->/g, "");
  const stack: string[] = [], problems: string[] = [];
  for (const [, close, name, attrs, self] of body.matchAll(/<(\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?)>/g)) {
    if (/=\s*[^"\s]/.test(attrs.replace(/"[^"]*"/g, '""'))) problems.push(`unquoted attribute on ${name}`);
    if (self) continue;
    if (close) { if (stack.pop() !== name) problems.push(`mismatched </${name}>`); } else stack.push(name);
  }
  if (stack.length) problems.push(`unclosed ${stack.join(",")}`);
  if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(body)) problems.push("bare ampersand");
  return problems;
}

test("FCPXML: the cut on one spine from 01:00:00:00, the Sound lanes connected under their shots with gain and mute, media by package path", () => {
  const p = project();
  const xml = makeFCPXML(p);
  expect(wellFormed(xml)).toEqual([]);
  expect(xml).toContain('<fcpxml version="1.10">');
  expect(xml).toContain('frameDuration="1/24s" width="1920" height="1080"');
  expect(xml).toContain(`src="media/${assetFilename(p.assets[0])}"`);
  expect(xml).toContain('name="01 — The crossing" offset="86400/24s" start="12/24s" duration="48/24s"');
  expect(xml).toContain('name="02 — The window" offset="86448/24s" start="0s" duration="72/24s"');
  /* The dialogue line starts at frame 60, 12 frames into shot 2 (which starts at 48). */
  expect(xml).toMatch(/lane="-1" name="Mara line" offset="12\/24s" start="0s" duration="24\/24s" audioRole="dialogue">\s*<adjust-volume amount="-6.0dB"\/>/);
  /* The score starts at frame 0, under shot 1, whose own time starts at its source in (12). */
  expect(xml).toContain('lane="-2" name="Score" offset="12/24s" start="24/24s" duration="120/24s" audioRole="music" enabled="0"');
  expect(xml).toContain("<note>Hold on the ice</note>");
  expect(xml).toContain('<event name="Fox &amp; &lt;Harbour&gt;">');
});

test("XMEML v4: one video track as cut, one audio track per lane, files defined once, levels and mute carried", () => {
  const p = project();
  const xml = makeXMEML(p);
  expect(wellFormed(xml)).toEqual([]);
  expect(xml).toContain('<xmeml version="4">');
  expect(xml).toContain("<string>01:00:00:00</string><frame>86400</frame>");
  expect(xml).toMatch(/<clipitem id="clip-v1"><name>01 — The crossing<\/name><duration>60<\/duration>.*<start>0<\/start><end>48<\/end><in>12<\/in><out>60<\/out>/);
  expect(xml).toMatch(/<clipitem id="clip-v2">.*<start>48<\/start><end>120<\/end>.*<stillframe>TRUE<\/stillframe>/);
  expect(xml.match(/<file id="file-gen-wide">/g)).toHaveLength(1);
  expect(xml).toContain(`<pathurl>media/${assetFilename(p.assets[2])}</pathurl>`);
  expect(xml).toContain("<!-- Dialogue -->");
  expect(xml).toContain("<!-- Music -->");
  expect(xml).not.toContain("<!-- Effects -->");
  expect(xml).toContain("<value>0.5012</value>");
  expect(xml).toMatch(/<name>Score<\/name><enabled>FALSE<\/enabled>/);
});

test("a changed frame rate keeps the cut's real time; an empty cut is refused, as for the EDL; text is escaped", () => {
  const p = retimeProject(project(), 25);
  expect(p.fps).toBe(25);
  expect(p.shots.map((s) => [s.sourceIn, s.duration])).toEqual([[13, 50], [0, 75]]);
  expect(p.audioClips!.map((c) => [c.startFrame, c.duration])).toEqual([[63, 25], [0, 125]]);
  const same = project();
  expect(retimeProject(same, 24)).toBe(same);
  expect(() => makeFCPXML({ ...project(), shots: [] })).toThrow("Add a shot before exporting.");
  expect(() => makeXMEML({ ...project(), shots: [] })).toThrow("Add a shot before exporting.");
  expect(escapeXml(`a & b < "c" 'd'\u0001`)).toBe("a &amp; b &lt; &quot;c&quot; &apos;d&apos; ");
});
