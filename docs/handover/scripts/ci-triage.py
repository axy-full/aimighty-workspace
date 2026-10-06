#!/usr/bin/env python3
"""
Sort one CI run's failing browser specs into the groups of CI-TRIAGE.md.  Read-only: GETs through the repo's gh-auth.py.

  python3 ci-triage.py <run-id>            # downloads the failed browser-shard logs (cached), prints Markdown
  python3 ci-triage.py <run-id> --dir D    # re-read logs already in D (no network)

A failure is matched by spec file and the start of its title (never the line number, which moves). Anything not in
RULES is printed under UNMAPPED with its first error line, so a new failure is never hidden in a known group.
Groups: A deleted page or state | B stale expectation | C product bug | D harness | E unknown. Batches F1..F6 are the fixer batches of CI-TRIAGE.md §4.
"""
import collections, glob, os, re, subprocess, sys, json

W = "/Users/axy/Documents/Codex/2026-09-13/vercel-plugin-vercel-openai-curated-remote-4/work"
GH = f"{W}/HANDOFF-2026-09-27-claude-resume/scripts/gh-auth.py"
REPO = "repos/axy-full/aimighty-workspace"
PHONES = {"360x640", "390x844", "844x390"}

# (spec file prefix, title starts with or None, group, batch, owner, money?)
RULES = [
    ("suites-business-own-agents", None, "A1 Business pages", "F1", "s11 Ads + board", True),
    ("suites-business-own-workbench", None, "A1 Business pages", "F1", "s11 Ads + board", True),
    ("suites-business-workbench", None, "A1 Business pages", "F1", "s11 Ads + board", True),
    ("demo-s11-ads", None, "B1 phone shell", "F1", "s11 + s10", False),
    ("demo-s01-switch", None, "A2 switch spec", "F6", "s01", False),
    ("demo-s04-looks-next", "Where to next", "A3 Crew address", "F4", "s04", False),
    ("demo-s02-home", None, "B1 phone shell", "F3", "s02 + s10", True),
    ("demo-s02-waiting", None, "B1 phone shell", "F3", "s02 + s10", True),
    ("demo-s08-", None, "B1 phone shell", "F3", "s08 + s10", True),
    ("demo-s09-settings", None, "B1 phone shell", "F3", "s09 + s10", False),
    ("demo-s06-make", None, "B1 phone shell", "F2", "s06 + s10", True),
    ("demo-s07-palette", None, "B1 phone shell", "F2", "s07 + s10", False),
    ("demo-s07-panel", "Ask Atomik how", "C2 Library offer is a no-op", "F5", "s07 (+ board)", False),
    ("demo-s07-panel", "commands never spend", "D4 844x390 is a phone to the shell", "F2", "s07", True),
    ("demo-s07-panel", "a request: Ask", "D4 844x390 is a phone to the shell", "F2", "s07", True),
    ("demo-s07-panel", None, "B1 phone shell", "F2", "s07 + s10", True),
    ("demo-s03-board", "the board's controls", "B2 stale selector (board-list)", "F4", "s03", False),
    ("demo-s03-board", None, "B1 phone shell", "F4", "s03 + s10", False),
    ("demo-s03-arrange", "a shot dragged", "B2 stale selector (.bd-eyebrow)", "F4", "s03 + s05", False),
    ("demo-s03-arrange", "a lasso", "D1 inspector covers the second click", "F4", "s03", False),
    ("demo-s03-drawers", None, "C1 drop on a shot card does nothing", "F4", "s05 (TakeCard)", False),
    ("demo-s05-shots", "Change with words", "D2 asked[0] is not the edit quote", "F4", "s05", True),
    ("entry-points-audit", None, "D3 redirectedFrom is one hop", "F5", "D0 shell", False),
    ("hf-error-boundaries", "Gen: one bad take", "C3 Make loses the typed words", "F5", "s06 / D0 Make", False),
    ("suites-asset-link", "a link from a workspace", "E1 link switch stays on 'workspace'", "F5", "board (asset link)", False),
    ("hf-phone-chrome", None, "B1 phone shell (old chrome)", "F6", "s10 / D0 phone bar", False),
    ("suites-viral", "the source's own tools", "D5 flake (390x844 only)", "F5", "s11 Social", False),
]


# A test asserts a price, money, an approval or "nothing is sent" when its title says so, or when it is listed here.
MONEY_WORDS = re.compile(r"\bcr\b|price|priced|approv|quote|estimate|ceiling|spend|spent|paid|billed|figure|dollars|balance|top up|nothing is made|never spend|settled|ledger", re.I)
MONEY_EXTRA = [("demo-s06-make", "Make, new interface"), ("demo-s06-make", "a press the server"), ("demo-s06-make", "Recent:"), ("demo-s06-make", "the quick tools"),
               ("demo-s07-panel", "the panel over a page"), ("demo-s07-palette", "make"), ("suites-business", ""), ("demo-s08-", ""), ("demo-s03-drawers", "")]


def is_money(file, title):
    return bool(MONEY_WORDS.search(title)) or any(file.startswith(f) and title.startswith(t) for f, t in MONEY_EXTRA)


def lookup(file, title):
    for pre, start, group, batch, owner, money in RULES:
        if file.startswith(pre) and (start is None or title.startswith(start)):
            return group, batch, owner, money
    return None


# Second tier: files CI-TRIAGE.md §5 expects to fail on release/1 for a named reason. Matched by spec file only and labelled
# "(predicted)": read the first error before trusting the label.
PREDICTED = {
    "F6a ?make= lands on Home (predicted)": "audit-other-ui cinema-controls cinema-sound handoff-library-recovery hf-batch-takes hf-card-contract hf-connected-jobs-finish hf-film-vocabulary hf-gen-output-coverage hf-model-picker make-short-form provider-billing-outcome seedance-draft-final suites-draft-merge suites-dragdrop suites-gen suites-prompt-attach suites-recovery suites-shell-audit suites-shell suites-workflows hf-credits-out hf-role-aware-connected make-prices make-quick-tools marketing-site suites-project-new suites-virtual-lists hf-recreate-recipe".split(),
    "F6b Agent page is Home + panel (predicted)": "suites-assets suites-atomik-gate suites-load-errors suites-next-actions suites-preview suites-shortcuts hf-shared-key hf-usage-ledger hf-first-run atomik-threads demo-autosave-before-atomik suites-asset-link".split(),
    "F6c old phone chrome (predicted)": "suites-phone-home hf-jobs-tray ui-floors-audit astra-phone-floors suites-shell-audit".split(),
}


def predicted(file):
    for group, names in PREDICTED.items():
        if any(file.startswith(n + "-workbench") or file.startswith(n + ".") for n in names):
            return group
    return None


def sh(*args):
    return subprocess.run(["python3", GH, "api", *args], capture_output=True, text=True).stdout


def fetch(run_id, out):
    os.makedirs(out, exist_ok=True)
    jobs = json.loads(sh(f"{REPO}/actions/runs/{run_id}/jobs?per_page=100"))["jobs"]
    todo = [j for j in jobs if j["conclusion"] == "failure" and "browser-shards" in j["name"]]
    print(f"<!-- run {run_id}: {len(jobs)} jobs, {len(todo)} failed browser shards; still running: "
          f"{sum(1 for j in jobs if j['status'] != 'completed')} -->")
    for j in todo:
        path = f"{out}/{j['id']}.log"
        if not os.path.exists(path):
            open(path, "w").write(sh(f"{REPO}/actions/jobs/{j['id']}/logs"))


def parse(out):
    res = []
    for f in sorted(glob.glob(out + "/*.log")):
        txt = re.sub(r"^\d{4}-[\d-]+T[\d:.]+Z ", "", open(f, errors="ignore").read(), flags=re.M)
        txt = re.sub(r"\x1b\[[0-9;]*m", "", txt)
        for b in re.split(r"\n\s+\d+\) \[", txt)[1:]:
            lines = b.split("\n")
            m = re.match(r"(\S+)\] › tests/(\S+?):(\d+):\d+ › (.*?)\s*$", lines[0])
            if not m:
                continue
            body = "\n".join(lines[1:40])
            e = re.search(r"(Error:.*|TimeoutError.*)", body)
            loc = re.search(r"Locator: (.*)", body)
            res.append(dict(proj=m.group(1).replace("workbench-", "").replace("customer-", "c"), file=m.group(2), line=int(m.group(3)),
                            title=m.group(4), err=(e.group(1)[:110] if e else "?"), loc=(loc.group(1)[:90] if loc else "")))
    return res


def main():
    a = sys.argv[1:]
    run_id = a[0]
    out = a[a.index("--dir") + 1] if "--dir" in a else f"/private/tmp/claude-501/ci/run-{run_id}"
    if "--dir" not in a:
        fetch(run_id, out)
    res = parse(out)
    tests = collections.OrderedDict()
    for r in res:
        tests.setdefault((r["file"], r["title"]), []).append(r)
    groups, batches, unmapped = collections.defaultdict(lambda: [0, 0]), collections.defaultdict(lambda: [0, 0]), []
    money = []
    for (file, title), rs in tests.items():
        hit = lookup(file, title)
        if hit is None and predicted(file):
            hit = (predicted(file), "F6", "see CI-TRIAGE §5", False)
        if hit is None:
            only_phone = all(r["proj"] in PHONES for r in rs)
            unmapped.append((file, title, rs, only_phone))
            continue
        g, b, o, _ = hit
        m = is_money(file, title)
        groups[g][0] += 1; groups[g][1] += len(rs)
        batches[b][0] += 1; batches[b][1] += len(rs)
        if m:
            money.append((file, rs[0]["line"], title[:80], sorted({r["proj"] for r in rs})))
    print(f"## Run {run_id}: {len(res)} failing (test x viewport), {len(tests)} tests\n")
    print("| group | tests | failures |\n|---|---|---|")
    for g, (t, n) in sorted(groups.items()): print(f"| {g} | {t} | {n} |")
    print(f"| UNMAPPED | {len(unmapped)} | {sum(len(rs) for _, _, rs, _ in unmapped)} |\n")
    print("| batch (F1..F6) | tests | failures |\n|---|---|---|")
    for b, (t, n) in sorted(batches.items()): print(f"| {b} | {t} | {n} |")
    print("\n### Money, price or approval tests that fail (keep them: move, never weaken)\n")
    for f, l, t, v in money: print(f"- `{f}:{l}` {t} [{', '.join(v)}]")
    print("\n### UNMAPPED (new since the triage; read the log)\n")
    for file, title, rs, only_phone in unmapped:
        r = rs[0]
        hint = "phone widths only: does the phone shell draw this address? (usually B1)" if only_phone else "desktop: product or harness, needs a read"
        print(f"- `{file}:{r['line']}` {title[:90]} [{', '.join(sorted({x['proj'] for x in rs}))}]\n    - {r['err']} | {r['loc']}\n    - {hint}")


main()
