import { audioClips, type AudioClip } from "./audio";
import { assetFilename, safeName, timecode, validateSequence, type Asset, type Project } from "./studio";

/**
 * Production › Delivery (owner's brief, 23 September): the cut as XML, beside
 * the CMX3600 EDL — FCPXML 1.10 for Final Cut Pro and DaVinci Resolve, and
 * XMEML v4 (Final Cut Pro 7 XML) for Premiere Pro and Avid via import. Both
 * carry the video track as cut and the Sound lanes (dialogue, music, effects)
 * at their positions, and point every clip at the packaged file
 * `media/<filename>` — the same names the editorial package writes. Record
 * starts at 01:00:00:00, like the EDL.
 */
const FRAME: Record<string, [number, number]> = { "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080], "4:5": [1080, 1350] };
const LANE_ORDER: AudioClip["lane"][] = ["dialogue", "music", "sfx"];
const LANE_NAME: Record<AudioClip["lane"], string> = { dialogue: "Dialogue", music: "Music", sfx: "Effects" };

export function escapeXml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
const path = (asset: Asset) => `media/${assetFilename(asset)}`;
/** Frames as an FCPXML rational time: `48/24s`. */
const t = (frames: number, fps: number) => (frames === 0 ? "0s" : `${frames}/${fps}s`);

type Placed = { asset: Asset; clip: AudioClip };
/** Every Sound clip, including a video's own sound (production sound from a take), which is placed audio-only. */
function placedAudio(p: Project): Placed[] {
  const byId = new Map(p.assets.map((a) => [a.id, a]));
  return audioClips(p).flatMap((clip) => { const asset = byId.get(clip.assetId); return asset && (asset.kind === "audio" || asset.kind === "video") ? [{ asset, clip }] : []; });
}
/** Every source's length as used: an asset is as long as the furthest frame the cut reads from it. */
function sourceLengths(p: Project, audio: Placed[]) {
  const length = new Map<string, number>();
  for (const shot of p.shots) length.set(shot.assetId, Math.max(length.get(shot.assetId) ?? 0, shot.sourceIn + shot.duration));
  for (const { clip } of audio) length.set(clip.assetId, Math.max(length.get(clip.assetId) ?? 0, clip.sourceIn + clip.duration));
  return length;
}

/** FCPXML 1.10: one spine of the cut; each Sound clip connected to the shot it starts under, on its lane. */
export function makeFCPXML(p: Project): string {
  validateSequence(p);
  const fps = p.fps, [width, height] = FRAME[p.aspect] ?? FRAME["16:9"];
  const audio = placedAudio(p);
  const lengths = sourceLengths(p, audio);
  const used = [...new Set([...p.shots.map((s) => s.assetId), ...audio.map((a) => a.asset.id)])];
  const byId = new Map(p.assets.map((a) => [a.id, a]));
  const ref = new Map(used.map((id, i) => [id, `a${i + 1}`]));
  const total = p.shots.reduce((n, s) => n + s.duration, 0);
  const assets = used.map((id) => {
    const a = byId.get(id)!;
    const video = a.kind !== "audio";
    return `    <asset id="${ref.get(id)}" name="${escapeXml(a.name)}" start="0s" duration="${t(lengths.get(id) ?? 1, fps)}" hasVideo="${video ? 1 : 0}" hasAudio="${a.kind === "image" ? 0 : 1}"${video ? ` format="r1"` : ""} audioSources="1" audioChannels="2">\n      <media-rep kind="original-media" src="${escapeXml(path(a))}"/>\n    </asset>`;
  });
  /* Each Sound clip hangs off the spine clip under its first frame (FCPXML connects clips to a parent). */
  const starts: number[] = [];
  p.shots.reduce((at, s) => { starts.push(at); return at + s.duration; }, 0);
  const connected = new Map<number, string[]>();
  for (const { asset, clip } of audio) {
    const at = Math.min(clip.startFrame, Math.max(0, total - 1));
    let index = starts.findIndex((s, i) => at >= s && at < s + p.shots[i].duration);
    if (index < 0) index = p.shots.length - 1;
    const shot = p.shots[index];
    const offset = shot.sourceIn + (clip.startFrame - starts[index]);
    const lane = -(LANE_ORDER.indexOf(clip.lane) + 1);
    const line = `          <asset-clip ref="${ref.get(asset.id)}" lane="${lane}" name="${escapeXml(asset.name)}" offset="${t(offset, fps)}" start="${t(clip.sourceIn, fps)}" duration="${t(clip.duration, fps)}" audioRole="${clip.lane === "sfx" ? "effects" : clip.lane}"${asset.kind === "video" ? ` srcEnable="audio"` : ""}${clip.muted ? ` enabled="0"` : ""}>${clip.gainDb ? `\n            <adjust-volume amount="${clip.gainDb.toFixed(1)}dB"/>\n          ` : ""}</asset-clip>`;
    connected.set(index, [...(connected.get(index) ?? []), line]);
  }
  const spine = p.shots.map((shot, i) => {
    const a = byId.get(shot.assetId)!;
    const children = connected.get(i) ?? [];
    const note = shot.note ? `\n          <note>${escapeXml(shot.note.slice(0, 300))}</note>` : "";
    return `        <asset-clip ref="${ref.get(a.id)}" name="${escapeXml(shot.name)}" offset="${t(3600 * fps + starts[i], fps)}" start="${t(shot.sourceIn, fps)}" duration="${t(shot.duration, fps)}" tcFormat="NDF">${note}${children.length ? "\n" + children.join("\n") : ""}\n        </asset-clip>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="Particl ${width}x${height} ${fps}p" frameDuration="1/${fps}s" width="${width}" height="${height}"/>
${assets.join("\n")}
  </resources>
  <library>
    <event name="${escapeXml(p.name)}">
      <project name="${escapeXml(safeName(p.name))}">
        <sequence format="r1" duration="${t(total, fps)}" tcStart="${t(3600 * fps, fps)}" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
${spine.join("\n")}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

/** XMEML v4 (Final Cut Pro 7 XML): one video track as cut, one audio track per Sound lane. */
export function makeXMEML(p: Project): string {
  validateSequence(p);
  const fps = p.fps, [width, height] = FRAME[p.aspect] ?? FRAME["16:9"];
  const audio = placedAudio(p);
  const lengths = sourceLengths(p, audio);
  const total = p.shots.reduce((n, s) => n + s.duration, 0);
  const rate = `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;
  const defined = new Set<string>();
  const file = (a: Asset) => {
    const id = `file-${escapeXml(a.id)}`;
    if (defined.has(id)) return `<file id="${id}"/>`;
    defined.add(id);
    const media = a.kind === "audio" ? `<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>`
      : `<video><samplecharacteristics>${rate}<width>${width}</width><height>${height}</height></samplecharacteristics></video>${a.kind === "video" ? `<audio><channelcount>2</channelcount></audio>` : ""}`;
    return `<file id="${id}"><name>${escapeXml(assetFilename(a))}</name><pathurl>${escapeXml(path(a))}</pathurl>${rate}<duration>${lengths.get(a.id) ?? 1}</duration><media>${media}</media></file>`;
  };
  const byId = new Map(p.assets.map((a) => [a.id, a]));
  let at = 0;
  const video = p.shots.map((shot, i) => {
    const a = byId.get(shot.assetId)!;
    const item = `        <clipitem id="clip-v${i + 1}"><name>${escapeXml(shot.name)}</name><duration>${lengths.get(a.id) ?? shot.duration}</duration>${rate}<start>${at}</start><end>${at + shot.duration}</end><in>${shot.sourceIn}</in><out>${shot.sourceIn + shot.duration}</out>${a.kind === "image" ? "<stillframe>TRUE</stillframe>" : ""}${file(a)}${shot.note ? `<comments><mastercomment1>${escapeXml(shot.note.slice(0, 300))}</mastercomment1></comments>` : ""}</clipitem>`;
    at += shot.duration;
    return item;
  });
  const tracks = LANE_ORDER.map((lane) => {
    const items = audio.filter((x) => x.clip.lane === lane).sort((a, b) => a.clip.startFrame - b.clip.startFrame).map(({ asset, clip }, i) =>
      `        <clipitem id="clip-${lane}-${i + 1}"><name>${escapeXml(asset.name)}</name><enabled>${clip.muted ? "FALSE" : "TRUE"}</enabled><duration>${lengths.get(asset.id) ?? clip.duration}</duration>${rate}<start>${clip.startFrame}</start><end>${clip.startFrame + clip.duration}</end><in>${clip.sourceIn}</in><out>${clip.sourceIn + clip.duration}</out>${file(asset)}<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>${clip.gainDb ? `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effecttype>audiolevels</effecttype><mediatype>audio</mediatype><parameter><parameterid>level</parameterid><name>Level</name><value>${Math.pow(10, clip.gainDb / 20).toFixed(4)}</value></parameter></effect></filter>` : ""}</clipitem>`);
    return items.length ? `      <track><!-- ${LANE_NAME[lane]} -->\n${items.join("\n")}\n      </track>` : "";
  }).filter(Boolean);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>${escapeXml(p.name)}</name>
    <duration>${total}</duration>
    ${rate}
    <timecode>${rate}<string>${timecode(3600 * fps, fps)}</string><frame>${3600 * fps}</frame><displayformat>NDF</displayformat></timecode>
    <media>
      <video>
        <format><samplecharacteristics>${rate}<width>${width}</width><height>${height}</height></samplecharacteristics></format>
        <track>
${video.join("\n")}
        </track>
      </video>
      <audio>
${tracks.join("\n")}
      </audio>
    </media>
  </sequence>
</xmeml>
`;
}

/**
 * The delivery spec's frame rate, changed without changing the cut: every
 * shot and Sound clip keeps its real-time position and length, re-counted in
 * the new rate's frames (a duration never drops below one frame).
 *
 * Edit points are converted, not lengths: each shot runs between its converted
 * start and end on the timeline, so the cut's length is the converted length
 * and a clip that ended with the cut still does. A clip's fades stay inside it,
 * and nothing reads past the end of its source after rounding.
 */
export function retimeProject(p: Project, fps: 24 | 25 | 30): Project {
  if (fps === p.fps) return p;
  const f = (frames: number) => Math.round((frames * fps) / p.fps);
  /* The converted in point, moved earlier by the rounding (never before 0) so in + length stays inside the source. */
  const sourceIn = (from: number, length: number, converted: number) => Math.max(0, Math.min(f(from), f(from + length) - converted));
  let old = 0, at = 0;
  const shots = p.shots.map((s) => {
    old += s.duration;
    const end = Math.max(at + 1, f(old)), duration = end - at;
    at = end;
    return { ...s, sourceIn: sourceIn(s.sourceIn, s.duration, duration), duration };
  });
  const total = at;
  const audio = p.audioClips?.map((c) => {
    const startFrame = f(c.startFrame);
    let duration = Math.max(1, f(c.startFrame + c.duration) - startFrame);
    // A clip that started inside the cut ends by the cut's end.
    if (startFrame < total) duration = Math.min(duration, total - startFrame);
    const fadeIn = Math.min(f(c.fadeIn), duration);
    return { ...c, startFrame, sourceIn: sourceIn(c.sourceIn, c.duration, duration), duration, fadeIn, fadeOut: Math.min(f(c.fadeOut), duration - fadeIn) };
  });
  return { ...p, fps, shots, ...(audio ? { audioClips: audio } : {}) };
}
