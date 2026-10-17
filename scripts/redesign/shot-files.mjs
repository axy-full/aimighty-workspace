/*
 * What publish-shots.mjs picks up and how it writes a PR table (pure: no git, no disk, tested in tests/unit/redesign-shot-files.spec.ts).
 *
 * A tag is the size a shot was taken at: `1920x1080`, or `2560x1440@2x` at a pixel ratio of 2 (tests/helpers/ownerSizes.ts).
 * Files: <tag>.json, <tag>-{app,proto}.png, <tag>-beside.png (pixel ratio 1 only), and the downscaled <tag>-{app,proto,beside}.webp
 * the PR table shows.
 */
export const SHOT_FILE = /^\d+x\d+(@\d+x)?(-(app|proto|beside))?\.(png|webp|json)$/;

/** Smallest size first, a size at a higher pixel ratio after the same size at a lower one. */
export function compareTags(a, b) {
  const parse = (t) => { const m = /^(\d+)x(\d+)(?:@(\d+)x)?$/.exec(t); return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 1)] : [0, 0, 0]; };
  const [pa, pb] = [parse(a), parse(b)];
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

/** The tags that have a JSON note, in table order. */
export function tagsOf(files) {
  return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort(compareTags);
}

/**
 * The Markdown for one size of one screen: downscaled WebPs in the table, each linking to its full PNG for pixel-checking.
 * A shot with no WebP (taken before WebPs) falls back to the PNG itself.
 */
export function tableFor({ tag, info, files, raw }) {
  const pic = (kind, label) => {
    const png = `${tag}-${kind}.png`, webp = `${tag}-${kind}.webp`;
    const shown = files.includes(webp) ? webp : png;
    const image = `![${label} ${tag}](${raw(shown)})`;
    return files.includes(png) ? `[${image}](${raw(png)})` : image;
  };
  const dpr = info.dpr && info.dpr !== 1 ? ` · pixel ratio ${info.dpr}, pictures downscaled here; click one for the full-size PNG` : "";
  return [`**${tag}** · build \`${info.app}\` · prototype \`${info.prototype}\`${dpr}`, "", `| Build | Prototype |`, `|---|---|`, `| ${pic("app", "build")} | ${pic("proto", "prototype")} |`, ""];
}
