"use client";
import type { ConsoleModels } from "@/lib/platformConsole.server";
import { PLATFORM_TEXT_PROVIDER_ORDER } from "@/lib/platformConsole";
import type { TextJob } from "@/lib/platformLayer";
import { useToast } from "../ui";
import { adminSend, useAdminRead } from "./api";
import { Cr, Head, Picker, type PickerOption } from "./parts";

const usd = (n: number): string => `$${Number(n.toFixed(2)).toLocaleString("en-US")}`;

/**
 * AI models: the engines a composer opens on, and the model each text job runs on. Only what has a working key is listed;
 * an engine is priced by the product's own rate path, a text model from the catalogue's price table (app/api/admin/console/
 * models). A pick saves as it is made, through the platform layer's own route (key `models`).
 */
export function Models() {
  const toast = useToast();
  const { data, refresh } = useAdminRead<ConsoleModels>("/api/admin/console/models", 0);

  async function save(next: { video: string; image: string; text: Record<TextJob, string> }) {
    const sent = await adminSend("/api/admin/platform-layer", "PATCH", { key: "models", value: next });
    toast({ text: sent.ok ? "Saved" : sent.error });
    refresh();
  }
  if (!data) return <Head title="AI models" line="Defaults for every workspace. A workspace can still pick per take." />;

  const text = Object.fromEntries(data.text.jobs.map((j) => [j.job, j.model])) as Record<TextJob, string>;
  const engineOptions = (kind: "video" | "image"): PickerOption[] => data.engines.filter((e) => e.kind === kind).map((e) => ({
    id: e.id, label: e.label,
    detail: <>{e.duration ? `${e.duration} s · ` : ""}{e.resolution} <Cr credits={e.credits} /></>,
  }));
  const textOptions: PickerOption[] = [...data.text.models].sort((a, b) => PLATFORM_TEXT_PROVIDER_ORDER.indexOf(a.provider) - PLATFORM_TEXT_PROVIDER_ORDER.indexOf(b.provider)).map((m) => ({
    id: m.id, label: m.name, group: m.providerLabel,
    detail: <span className="v12-pc-mono">{usd(m.inputUsdPerM)} · {usd(m.outputUsdPerM)} /1M</span>,
  }));

  return (
    <>
      <Head title="AI models" line="Defaults for every workspace. A workspace can still pick per take." />
      <h2 className="v12-pc-h2">Defaults</h2>
      <div className="v12-pc-rows" data-testid="pc-models">
        <div className="v12-pc-field"><span className="v12-pc-fname">Default video engine</span>
          <Picker label="Default video engine" value={data.defaults.video} options={engineOptions("video")} testId="pc-model-video" onChange={(id) => void save({ video: id, image: data.defaults.image, text })} /></div>
        <div className="v12-pc-field"><span className="v12-pc-fname">Default still engine</span>
          <Picker label="Default still engine" value={data.defaults.image} options={engineOptions("image")} testId="pc-model-image" onChange={(id) => void save({ video: data.defaults.video, image: id, text })} /></div>
      </div>
      <h2 className="v12-pc-h2">Text models <span className="v12-pc-sub">Only models with a working key are listed. Dollars per million tokens in · out.</span></h2>
      <div className="v12-pc-rows">
        {data.text.jobs.map((j) => (
          <div key={j.job} className="v12-pc-field"><span className="v12-pc-fname">{j.label}</span>
            <Picker label={j.label} value={j.model} options={textOptions} testId={`pc-model-${j.job}`} onChange={(id) => void save({ video: data.defaults.video, image: data.defaults.image, text: { ...text, [j.job]: id } })} /></div>
        ))}
      </div>
    </>
  );
}
