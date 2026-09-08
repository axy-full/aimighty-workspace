import { NextResponse } from "next/server";
import { requireUser, requireRender, withTenant } from "@/lib/auth";
import { db, ready, now } from "@/lib/db";
import { listElements, listBindings, setBinding, clearBinding } from "@/lib/elements";
import { quoteShots } from "@/lib/impact";
import { isSlot, type Slot } from "@/lib/rig";
import { billedCreditsExpr } from "@/lib/creditSql";

/**
 * One shot's five slots (brief 3, surface 2c). The id is the shot's.
 *
 * The counterpart to the impact panel, and deliberately the smaller act. The
 * panel changes what EVERYTHING follows and has to stop and ask; this pins one
 * shot to one version and reaches nothing else, so it saves without a question
 * — and costs nothing, because a binding is not a render. What it would cost
 * to render the shot again is quoted anyway and put on the surface, since the
 * whole reason to change a slot is to render it.
 *
 * Every read here is db(), which is the workspace in scope and throws when
 * there is none; every write is scoped by a shot this workspace owns.
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

type ShotRow = { id: string; project_id: string | null; code: string; title: string; status: string };

async function shotOf(shotId: string): Promise<ShotRow | null> {
  const rs = await db().execute({
    sql: `SELECT id, project_id, code, title, status FROM shots WHERE id = ?`, args: [shotId],
  });
  return rs.rows.length ? (rs.rows[0] as unknown as ShotRow) : null;
}

export const GET = withTenant(async function GET(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();

  const { id: shotId } = await params;
  const shot = await shotOf(shotId);
  if (!shot) return NextResponse.json({ error: "No such shot." }, { status: 404 });

  const [bindings, elements, takeRs, quoted] = await Promise.all([
    listBindings(shotId),
    /* The production's own elements plus the workspace's shared ones, which
       is exactly the set a slot may point at. */
    listElements(shot.project_id),
    /* The take on the strip: the newest one, and whether it is signed off.
       Its credits are read from the ledger rather than re-quoted — what a
       take cost is a fact about the past and must not move when a price does. */
    /* Prefer an approved take, then a picked one, then the newest. The first
       draft took the newest row of any kind, so a still reference filed
       against the shot could report itself as the shot's take — and a shot
       whose approved take had been followed by a fresh draft read as DRAFT,
       disagreeing with the impact panel, which asks whether the SHOT has an
       approved take at all. */
    db().execute({
      sql: `SELECT id, version, review_state, params, kind, ${billedCreditsExpr("generations")} AS credits
            FROM generations
            WHERE shot_id = ? AND deleted = 0 AND status = 'succeeded'
            ORDER BY CASE review_state WHEN 'approved' THEN 0 WHEN 'picked' THEN 1 ELSE 2 END,
                     version DESC, created_at DESC
            LIMIT 1`,
      args: [shotId],
    }),
    quoteShots([shotId], { at: now(), isAdmin: got.user.role === "admin" }),
  ]);

  let take = null as null | { id: string; version: number; state: string; approved: boolean; kind: string; seconds: number | null; credits: number };
  if (takeRs.rows.length) {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const r = takeRs.rows[0] as any;
    let seconds: number | null = null;
    try { const p = JSON.parse(String(r.params ?? "{}")); seconds = p?.duration == null ? null : Number(p.duration); } catch { seconds = null; }
    take = {
      id: String(r.id), version: Number(r.version ?? 1),
      state: String(r.review_state ?? ""),
      approved: String(r.review_state ?? "") === "approved",
      kind: String(r.kind ?? "video"),
      seconds, credits: Math.round(Number(r.credits ?? 0)),
    };
  }

  return NextResponse.json({
    shot: { id: shot.id, projectId: shot.project_id, code: shot.code, title: shot.title, status: shot.status },
    take, bindings, elements,
    credits: quoted.quote.totalCredits,
    verdict: quoted.verdict,
    pricedAt: quoted.pricedAt,
  });
});

type Change = { slot: Slot; ordinal: number; elementId: string | null; attributeId: string | null; versionId: string | null };

function readChanges(raw: unknown): Change[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Change[] = [];
  for (const c of raw) {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const x = c as any;
    if (!isSlot(x?.slot)) return null;
    /* Absent means the first. Present-but-not-a-whole-number is a malformed
       address, and defaulting it to 0 would write over a binding the caller
       never named. */
    if (x?.ordinal !== undefined && (!Number.isInteger(x.ordinal) || x.ordinal < 0)) return null;
    out.push({
      slot: x.slot,
      ordinal: x?.ordinal === undefined ? 0 : Number(x.ordinal),
      elementId: x?.elementId ? String(x.elementId) : null,
      attributeId: x?.attributeId ? String(x.attributeId) : null,
      versionId: x?.versionId ? String(x.versionId) : null,
    });
  }
  return out;
}

export const PUT = withTenant(async function PUT(req: Request, { params }: Ctx) {
  const got = await requireRender();
  if (got.response) return got.response;
  await ready();

  const { id: shotId } = await params;
  const shot = await shotOf(shotId);
  if (!shot) return NextResponse.json({ error: "No such shot." }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const changes = readChanges((body as any)?.changes);
  if (!changes) return NextResponse.json({ error: "Name the slots to change." }, { status: 400 });
  if (!changes.length) return NextResponse.json({ ok: true, changed: 0 });

  /* One address, one change. Two entries for the same (slot, ordinal) would
     both be written, the last quietly winning, and the count returned to the
     surface would say two changes landed where one did. A batch that cannot
     say what it did is refused rather than half-applied. */
  const seen = new Set<string>();
  for (const c of changes) {
    const at = `${c.slot}:${c.ordinal}`;
    if (seen.has(at)) return NextResponse.json({ error: "That slot is named twice." }, { status: 400 });
    seen.add(at);
  }

  /* Everything this shot may legally point at, read once. An id that is not
     in here belongs to another production or to nothing, and a binding row
     that names it would put a wire on the canvas to a node that is not
     there — so it is refused rather than written and cleaned up later. */
  /* An unfiled shot gets the SHARED library only. listElements(null) means
     "everything in the workspace", which for a shot with no production of its
     own would have been every other production's private elements as well —
     a wire from one production's character into a shot that is not in it. */
  const allowed = (await listElements(shot.project_id))
    .filter((e) => (shot.project_id ? true : e.projectId == null));
  const byId = new Map(allowed.map((e) => [e.id, e]));

  /* What is bound NOW, because a lock protects the slot as it stands and not
     only what is arriving. Checking the incoming element alone let a locked
     look be cleared, or re-pointed at an unlocked element — the lock held
     against changing the version and against nothing else, which is the same
     as not holding. */
  const current = await listBindings(shotId);
  const lockedAlready = new Map<string, string>();
  for (const b of current) {
    const el = byId.get(b.elementId);
    if (!el) continue;
    const attr = b.attributeId ? el.attributes.find((a) => a.id === b.attributeId) ?? null : null;
    if (el.locked || attr?.locked) lockedAlready.set(`${b.slot}:${b.ordinal}`, el.name);
  }

  for (const c of changes) {
    const held = lockedAlready.get(`${c.slot}:${c.ordinal}`);
    if (held) return NextResponse.json({ error: `${held} is locked on this shot.` }, { status: 409 });
    if (!c.elementId) continue;
    const el = byId.get(c.elementId);
    if (!el) return NextResponse.json({ error: "That element is not one this shot can use." }, { status: 404 });
    /* A locked element is locked here too. The library is where a lock comes
       off; letting one shot slip past it would make the lock advisory, which
       is the same as not having one. */
    if (el.locked) return NextResponse.json({ error: `${el.name} is locked.` }, { status: 409 });

    if (c.attributeId) {
      const attr = el.attributes.find((a) => a.id === c.attributeId);
      if (!attr) return NextResponse.json({ error: "That attribute is not one of this element's." }, { status: 404 });
      if (attr.locked) return NextResponse.json({ error: `${el.name}'s ${attr.label || attr.kind} is locked.` }, { status: 409 });
      if (c.versionId) {
        const v = attr.versions.find((x) => x.id === c.versionId);
        if (!v) return NextResponse.json({ error: "That version is not one of this attribute's." }, { status: 404 });
        /* Same reason the swap route refuses one: a version still rendering
           its views is not an image yet, and a shot bound to it would quote
           for something that does not exist. */
        if (v.status !== "ready") return NextResponse.json({ error: "That version is not ready yet." }, { status: 409 });
      }
    } else if (c.versionId) {
      /* A version without its attribute is a port that cannot be resolved:
         nothing could say which of the element's attributes it pins. */
      return NextResponse.json({ error: "A pinned version needs its attribute." }, { status: 400 });
    }
  }

  /* Nothing above this line has written. Every change is checked first so a
     batch with one bad entry leaves the shot exactly as it was, rather than
     half-rebound to a state nobody asked for. */
  let changed = 0;
  for (const c of changes) {
    if (!c.elementId) {
      if (await clearBinding(shotId, c.slot, c.ordinal)) changed += 1;
      continue;
    }
    const row = await setBinding({
      shotId, slot: c.slot, ordinal: c.ordinal,
      port: { elementId: c.elementId, attributeId: c.attributeId, versionId: c.versionId },
    }, got.user.email);
    if (row) changed += 1;
  }

  /* Re-quoted after the write, not before: the surface's next press is the
     one that spends, and it has to carry the price of the shot as it now is. */
  const quoted = await quoteShots([shotId], { at: now(), isAdmin: got.user.role === "admin" });
  return NextResponse.json({
    ok: true, changed,
    bindings: await listBindings(shotId),
    credits: quoted.quote.totalCredits,
    verdict: quoted.verdict,
  });
});
