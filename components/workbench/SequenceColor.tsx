"use client";
import { useRef, useState } from "react";
import { defaultColorGrade, type ColorGrade } from "@/lib/workbench/color";
import { parseCube, LUT_TEXT_LIMIT } from "@/lib/workbench/color-lut";
import type { Project } from "@/lib/workbench/studio";
import styles from "./SoundMix.module.css";
import colorStyles from "./SequenceColor.module.css";

export function SequenceColor({
  project,
  onChange,
  onImport,
}: {
  project: Project;
  onChange: (fn: (project: Project) => Project) => void;
  onImport: (file: File) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const grade = project.colorGrade || defaultColorGrade;
  const luts = project.assets.filter(
    (asset) =>
      asset.kind === "document" &&
      asset.uploadId &&
      /\.cube$/i.test(asset.name),
  );
  function update(fields: Partial<ColorGrade>) {
    onChange((previous) => ({
      ...previous,
      colorGrade: { ...defaultColorGrade, ...previous.colorGrade, ...fields },
    }));
  }
  async function upload(file?: File) {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    try {
      if (!/\.cube$/i.test(file.name) || file.size > LUT_TEXT_LIMIT)
        throw new Error("Choose a 3D .cube LUT up to 16 MB.");
      parseCube(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        ),
      );
      await onImport(
        new File([file], file.name, { type: "application/octet-stream" }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "LUT import failed.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <section
      className={`${styles.panel} ${colorStyles.panel}`}
      aria-labelledby="sequence-color-title"
    >
      <header>
        <div>
          <span className="eyebrow">COLOR</span>
          <h3 id="sequence-color-title">Sequence look</h3>
        </div>
        <button
          className="btn"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? "Importing LUT…" : "Import .cube LUT"}
        </button>
      </header>
      <input
        ref={input}
        type="file"
        accept=".cube"
        aria-label="Import sequence LUT"
        hidden
        onChange={(event) => void upload(event.target.files?.[0])}
      />
      <fieldset disabled={busy} className={styles.clip}>
        <legend>Applies to every shot · originals retained</legend>
        <div className={`${styles.add} ${colorStyles.sources}`}>
          <label htmlFor="sequence-lut">LUT</label>
          <select
            id="sequence-lut"
            aria-label="Sequence LUT"
            value={grade.lutAssetId || ""}
            onChange={(event) =>
              update({
                lutAssetId: event.target.value || undefined,
                bypassed: false,
              })
            }
          >
            <option value="">No LUT</option>
            {luts.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.name}
              </option>
            ))}
          </select>
          <label className={styles.inline}>
            <input
              type="checkbox"
              checked={grade.bypassed}
              onChange={(event) => update({ bypassed: event.target.checked })}
            />
            Bypass sequence look
          </label>
        </div>
        <div className={styles.controls}>
          {(
            [
              ["mix", "LUT mix"],
              ["brightness", "Brightness"],
              ["contrast", "Contrast"],
              ["saturation", "Saturation"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label} · {Math.round(grade[key] * 100)}%
              <input
                aria-label={label}
                type="range"
                min={0}
                max={key === "mix" ? 100 : 200}
                step={1}
                value={Math.round(grade[key] * 100)}
                disabled={key === "mix" && !grade.lutAssetId}
                onChange={(event) =>
                  update({ [key]: Number(event.target.value) / 100 })
                }
              />
            </label>
          ))}
        </div>
        <div className={styles.actions}>
          <button className="btn" onClick={() => update(defaultColorGrade)}>
            Reset adjustments
          </button>
          <button
            className="btn"
            onClick={() =>
              onChange((previous) => ({ ...previous, colorGrade: undefined }))
            }
          >
            Clear sequence look
          </button>
        </div>
      </fieldset>
      <p>
        Preview and final movie use the same look. Brightness, contrast and
        saturation precede the LUT. Processing uses browser-decoded SDR RGB and
        an 8-bit output; choose a LUT that matches your source. Log, HDR and
        ACES are not converted automatically.
      </p>
      <details>
        <summary>Where to source LUTs</summary>
        <p>
          For generated SDR images, use a display-referred creative LUT. For
          camera footage, obtain the matching camera transform from{" "}
          <a
            href="https://www.arri.com/en/learn-help/learn-help-camera-system/tools/lut-generator"
            target="_blank"
            rel="noreferrer"
          >
            ARRI
          </a>{" "}
          or{" "}
          <a
            href="https://pro.sony/en_CA/technology/professional-video-lut-look-up-table"
            target="_blank"
            rel="noreferrer"
          >
            Sony
          </a>
          . Camera log transforms require their specified input gamma and gamut.
          Import a standalone 3D .cube (2–65 points); combined 1D shapers are
          unsupported. Check its license for studio use.
        </p>
      </details>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </section>
  );
}
