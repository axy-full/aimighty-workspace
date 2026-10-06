"""Private read-only handoff snapshot. Never prints credentials or reads env files."""
import json, subprocess, sys
from pathlib import Path
from datetime import datetime, timezone

folder = Path(__file__).resolve().parents[1]
work = folder.parent
old = work / "HANDOFF-2026-09-27-astra6/codex-continuation"

def run(args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()

def gh(*args):
    return json.loads(run([sys.executable, str(old / "gh-auth.py"), *args, "--repo", "axy-full/aimighty-workspace"]))

checkouts = ["glass", "hf-takes", "hf-atomik", "hf-takes-desk", "hf-credits-out", "hf-jobs", "crew-grok-mcp", "hf-phone-chrome", "hf-billing-outcome", "hf-seedance-draft", "hf-connected", "handoff-stage-actions", "handoff-library-recovery", "handoff-genjutsu-contract", "handoff-batch-scope", "handoff-ci-teardown", "shorts-fixture", "app-redesign"]
states = []
for name in checkouts:
    path = work / name
    git = lambda *args: run(["git", *args], path)
    try:
        states.append({"path": str(path), "branch": git("branch", "--show-current"), "head": git("rev-parse", "HEAD"), "status": git("status", "--short"), "mainBase": git("merge-base", "HEAD", "origin/main"), "diffFromMain": git("diff", "--stat", "origin/main...HEAD")})
    except subprocess.CalledProcessError as error:
        states.append({"path": str(path), "error": str(error)})

result = {
    "capturedAt": datetime.now(timezone.utc).isoformat(),
    "main": run(["git", "rev-parse", "origin/main"], work / "glass"),
    "mainLog": run(["git", "log", "--oneline", "-15", "origin/main"], work / "glass"),
    "openPRs": gh("pr", "list", "--state", "open", "--limit", "50", "--json", "number,title,url,headRefName,headRefOid,baseRefName,isDraft,statusCheckRollup"),
    "runs": gh("run", "list", "--workflow", "verify.yml", "--limit", "20", "--json", "databaseId,headSha,headBranch,status,conclusion,createdAt,url"),
    "checkouts": states,
}
(folder / "evidence/live-state.json").write_text(json.dumps(result, indent=2) + "\n")
(folder / "evidence/worktree-list.txt").write_text(run(["git", "worktree", "list", "--porcelain"], work / "glass") + "\n")
print(json.dumps({"main": result["main"], "openPRs": [{"number": p["number"], "head": p["headRefOid"], "base": p["baseRefName"], "draft": p["isDraft"]} for p in result["openPRs"]], "dirty": [{"path": s["path"], "status": s.get("status")} for s in states if s.get("status")]}))
