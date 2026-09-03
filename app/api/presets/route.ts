import { NextResponse } from "next/server";
import { db, ready, now } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import {
  listLooks, coversFor, cleanSpec, newLookId, LOOK_CATEGORIES, MAX_LOOK_REFS,
} from "@/lib/looks";

export const dynamic = "force-dynamic";

const scope = (v: string | null) => (v && v !== "all" && v !== "unfiled" ? v : null);

function cleanRefs(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter((x) => typeof x === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(x)).slice(0, MAX_LOOK_REFS);
}
function cleanCategory(v: unknown): string {
  const s = String(v ?? "").trim();
  return (LOOK_CATEGORIES as readonly string[]).includes(s) ? s : "Custom";
}

/** Looks belong to a project, or to the whole workspace when made from
 *  "All projects" — the same rule the cast follows. Shipped Looks are always
 *  workspace-wide. Every Look comes with the cover it has earned. */
export async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const projectId = scope(new URL(req.url).searchParams.get("projectId"));
  const looks = await listLooks(projectId);
  const covers = await coversFor(looks);
  return NextResponse.json({
    categories: LOOK_CATEGORIES,
    presets: looks.map((l) => ({ ...l, cover: covers.get(l.id) ?? null })),
  });
}

export async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const body = await req.json().catch(() => ({}));

  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Give the look a name." }, { status: 400 });
  if (name.length > 60) return NextResponse.json({ error: "That name is too long." }, { status: 400 });
  const spec = cleanSpec(body.spec);
  const prose = String(body.prose ?? "").trim().slice(0, 1200);
  const refs = cleanRefs(body.refs);
  if (!Object.keys(spec).length && !prose && !refs.length) {
    return NextResponse.json({ error: "A look needs at least one chip, a style block, or a reference." }, { status: 400 });
  }

  const id = newLookId();
  const ts = now();
  await db().execute({
    sql: `INSERT INTO shot_presets
            (id, project_id, name, spec, created_by, created_at,
             category, blurb, prose, refs, cover_gen_id, cover_upload_id, swatch, builtin, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    args: [id, scope(body.projectId ?? null), name, JSON.stringify(spec), got.user.id, ts,
           cleanCategory(body.category), String(body.blurb ?? "").trim().slice(0, 140),
           prose, JSON.stringify(refs),
           body.coverGenId ? String(body.coverGenId) : null,
           body.coverUploadId ? String(body.coverUploadId) : null,
           body.swatch && Array.isArray(body.swatch) && body.swatch.length === 2
             ? JSON.stringify(body.swatch.map(String)) : null,
           ts],
  });
  return NextResponse.json({ id });
}
