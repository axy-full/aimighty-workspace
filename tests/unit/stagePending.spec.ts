import { test, expect } from "@playwright/test";
import { newProject } from "../../lib/workbench/studio";
import { projectSchema } from "../../lib/workbench/studio-schema";
import { merge3 } from "../../lib/workbench/merge";
import { DEFAULT_BOARDS } from "../../lib/production/boards";
import { DEFAULT_ENVIRONMENT, newEnvironmentEntry } from "../../lib/production/environment";

const at = "2026-09-27T00:00:00.000Z";
const pending = Array.from({ length: 12 }, (_, i) => ({ jobId: `gen_pending_${i}`, at, style: "bw-sketch" as const }));

test("drafts retain every pending frame and plate past the fifth job", () => {
  const project = { ...newProject("Pending renders"), production: {
    boards: { ...DEFAULT_BOARDS, frames: { shot: { prompt: "A quiet harbour", takes: [], pending } } },
    environment: { ...DEFAULT_ENVIRONMENT, entries: [{ ...newEnvironmentEntry("Harbour"), pending: pending.map(({ jobId, at }) => ({ jobId, at })) }] },
  } };
  const parsed = projectSchema.parse(project);
  expect(parsed.production!.boards!.frames.shot.pending).toEqual(pending);
  expect(parsed.production!.environment!.entries[0].pending).toEqual(pending.map(({ jobId, at }) => ({ jobId, at })));
});

test("concurrent saves retain different pending jobs and a terminal removal", () => {
  const base = { pending: pending.slice(0, 7) };
  const mine = { pending: [...base.pending.slice(1), pending[7]] };
  const theirs = { pending: [...base.pending, pending[8]] };
  const merged = merge3(base, mine, theirs);
  expect(merged.pending.map((job) => job.jobId).sort()).toEqual(pending.slice(1, 9).map((job) => job.jobId).sort());
});
