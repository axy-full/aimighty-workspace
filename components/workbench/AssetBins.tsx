"use client";
import { useState } from "react";
import { ChevronDown, Folder } from "lucide-react";
import type { Project, Asset } from "@/lib/workbench/studio";
import { uid } from "@/lib/workbench/studio";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import styles from "./editorial.module.css";
import { MobilePanel, useMobileLayout } from "./mobile-ui";
type Change = (fn: (p: Project) => Project) => void;
export function AssetBins({
  project,
  selected,
  onSelect,
  onChange,
}: {
  project: Project;
  selected: string;
  onSelect: (id: string) => void;
  onChange: Change;
}) {
  const [name, setName] = useState(""),
    [error, setError] = useState("");
  const mobile = useMobileLayout();
  const [binsOpen, setBinsOpen] = useState(false);
  const bins = project.bins ?? [],
    active = bins.find((b) => b.id === selected);
  function create() {
    const label = name.trim();
    if (
      !label ||
      bins.some((b) => b.name.toLowerCase() === label.toLowerCase())
    ) {
      setError("Give this bin a unique name.");
      return;
    }
    if (bins.length >= 50) {
      setError("This project has reached its 50-bin limit.");
      return;
    }
    const id = uid("bin");
    onChange((p) => ({
      ...p,
      bins: [...(p.bins ?? []), { id, name: label, assetIds: [] }],
    }));
    onSelect(id);
    setName("");
    setError("");
  }
  function rename() {
    const label = name.trim();
    if (
      !active ||
      !label ||
      bins.some(
        (b) =>
          b.id !== active.id && b.name.toLowerCase() === label.toLowerCase(),
      )
    ) {
      setError("Enter a unique bin name.");
      return;
    }
    onChange((p) => ({
      ...p,
      bins: p.bins?.map((b) =>
        b.id === active.id ? { ...b, name: label } : b,
      ),
    }));
    setName("");
    setError("");
  }
  const controls = (
    <section className={styles.bins} aria-label="Asset bins">
      <label>
        Bin
        <select
          aria-label="Asset bin"
          value={selected === "unfiled" ? "unfiled" : (active?.id ?? "")}
          onChange={(e) => {
            onSelect(e.target.value);
            setError("");
          }}
        >
          <option value="">All assets · {project.assets.length}</option>
          <option value="unfiled">Unfiled</option>
          {bins.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} · {b.assetIds.length}
            </option>
          ))}
        </select>
      </label>
      <label>
        Bin name
        <input
          aria-label="Bin name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              create();
            }
          }}
        />
      </label>
      <button className="btn" onClick={create} disabled={!name.trim()}>
        New bin
      </button>
      {active && (
        <>
          <button className="btn" onClick={rename} disabled={!name.trim()}>
            Rename bin
          </button>
          <button
            className="btn"
            onClick={() => {
              onChange((p) => ({
                ...p,
                bins: p.bins?.filter((b) => b.id !== active.id),
              }));
              onSelect("");
            }}
          >
            Remove bin
          </button>
        </>
      )}
      <small>
        Use an asset’s actions to organize it. Removing a bin keeps every asset.
      </small>
      {error && <p role="alert">{error}</p>}
    </section>
  );
  if (!mobile) return controls;
  return (
    <>
      <button
        type="button"
        className={styles.binsTrigger}
        aria-label="Open asset bins"
        aria-expanded={binsOpen}
        onClick={() => setBinsOpen(true)}
      >
        <Folder size={15} />
        <span>{selected === "unfiled" ? "Unfiled" : active?.name || "All assets"}</span>
        <ChevronDown size={14} />
      </button>
      <MobilePanel
        mobile={mobile}
        open={binsOpen}
        onOpenChange={setBinsOpen}
        title="Asset bins"
        description="Organize your assets. Removing a bin keeps every asset."
        kind="asset-bins"
      >
        <div className={styles.binsSheet}>{controls}</div>
      </MobilePanel>
    </>
  );
}
export function AssetBinPicker({
  project,
  asset,
  onChange,
  onClose,
}: {
  project: Project;
  asset: Asset;
  onChange: Change;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className={styles.dialog}>
        <DialogHeader>
          <DialogTitle>Organize {asset.name}</DialogTitle>
          <DialogDescription>
            Keep this asset in one or more bins. Its source and references stay
            connected.
          </DialogDescription>
        </DialogHeader>
        <div className={styles.binChoices}>
          {(project.bins ?? []).map((bin) => (
            <label key={bin.id}>
              <input
                type="checkbox"
                checked={bin.assetIds.includes(asset.id)}
                onChange={(e) => {
                  const checked = e.target.checked;
                  onChange((p) => ({
                    ...p,
                    bins: p.bins?.map((b) =>
                      b.id === bin.id
                        ? {
                            ...b,
                            assetIds: checked
                              ? [...new Set([...b.assetIds, asset.id])]
                              : b.assetIds.filter((id) => id !== asset.id),
                          }
                        : b,
                    ),
                  }));
                }}
              />
              {bin.name}
            </label>
          ))}
          {!project.bins?.length && (
            <p>Create a bin in Assets & takes, then add this asset.</p>
          )}
        </div>
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </DialogContent>
    </Dialog>
  );
}
