import fs from "node:fs/promises";
import path from "node:path";
const source = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const aac = path.join(source, "packages/aac-encoder");
const metadata = JSON.parse(
  await fs.readFile(path.join(aac, "package.json"), "utf8"),
);
metadata.version = "1.56.2-particl.1";
metadata.description += " Particl rebuild from pinned FFmpeg 8.0.1 sources.";
metadata.license = "SEE LICENSE IN NOTICE.txt";
metadata.files = [
  "README.md",
  "NOTICE.txt",
  "LICENSE",
  "licenses",
  "dist",
  "src",
  "build",
  "shared",
];
delete metadata.devDependencies;
await fs.writeFile(
  path.join(output, "package.json"),
  JSON.stringify(metadata, null, 2) + "\n",
);
for (const filename of ["README.md", "LICENSE", "NOTICE.txt"]) {
  await fs.copyFile(path.join(aac, filename), path.join(output, filename));
}
for (const folder of ["src", "build", "licenses"]) {
  await fs.cp(path.join(aac, folder), path.join(output, folder), {
    recursive: true,
  });
}
await fs.cp(path.join(source, "shared"), path.join(output, "shared"), {
  recursive: true,
});
await fs.cp(path.join(aac, "types"), path.join(output, "dist/modules/src"), {
  recursive: true,
});
