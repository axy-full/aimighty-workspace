import json, re, subprocess, sys
from pathlib import Path
folder=Path(__file__).resolve().parent
repo=folder.parents[1]/"glass"
def gh(*args):
    r=subprocess.run([sys.executable,str(folder/"gh-auth.py"),*args,"--repo","axy-full/aimighty-workspace"],text=True,capture_output=True)
    if r.returncode: raise SystemExit(r.stderr[:400])
    return json.loads(r.stdout)
def git(*args):
    return subprocess.check_output(["git",*args],cwd=repo,text=True).strip()
def ghapi(path):
    r=subprocess.run([sys.executable,str(folder/"gh-auth.py"),"api",path],text=True,capture_output=True)
    return r.stdout if r.returncode==0 else ""
def tested_base(run_id,head):
    """The main commit the run actually tested against, read from a job's checkout line
    ("HEAD is now at <sha> Merge <head> into <base>"). None if it can't be read."""
    try: jobs=json.loads(ghapi(f"repos/axy-full/aimighty-workspace/actions/runs/{run_id}/jobs?per_page=100"))["jobs"]
    except Exception: return None
    for job in sorted(jobs,key=lambda j:(not j["name"].startswith(("core","unit")),j["name"]))[:4]:
        m=re.search(r"HEAD is now at [0-9a-f]+ Merge ([0-9a-f]{40}) into ([0-9a-f]{40})",ghapi(f"repos/axy-full/aimighty-workspace/actions/jobs/{job['id']}/logs"))
        if m: return m.group(2) if m.group(1)==head else None
    return None
def merged_tree(base,head):
    r=subprocess.run(["git","merge-tree","--write-tree",base,head],cwd=repo,text=True,capture_output=True)
    return r.stdout.split("\n",1)[0].strip() if r.returncode==0 else None
number=sys.argv[1]
p=gh("pr","view",number,"--json","state,headRefOid,statusCheckRollup,baseRefName")
result={"pr":int(number),"head":p["headRefOid"],"verdict":"WAIT"}
if p["state"]!="OPEN": result["verdict"]=p["state"]
elif p["baseRefName"]!="main": result["verdict"]="WRONG_BASE"
else:
    runs=gh("run","list","--commit",p["headRefOid"],"--workflow","verify.yml","--limit","1","--json","databaseId,headSha,status,conclusion,createdAt")
    if runs:
        run=runs[0];result["run"]=run
        if run["status"]=="completed":
            checks=p["statusCheckRollup"]
            passed={c.get("name") for c in checks if c.get("conclusion")=="SUCCESS"}
            required={"browser (workbench)","browser (customer)"}<=passed
            settled=all((c.get("status")=="COMPLETED" and c.get("conclusion") in ["SUCCESS","SKIPPED","NEUTRAL"]) if c.get("name") else c.get("state")=="SUCCESS" for c in checks)
            result["failed"]=[c.get("name",c.get("context")) for c in checks if c.get("conclusion") in ["FAILURE","CANCELLED","TIMED_OUT","ACTION_REQUIRED"] or c.get("state") in ["FAILURE","ERROR"]]
            if run["conclusion"]!="success" or result["failed"]: result["verdict"]="RED"
            elif required and settled and run["headSha"]==p["headRefOid"]:
                subprocess.run(["git","fetch","-q","origin"],cwd=repo,check=True)
                result["main"]=git("rev-parse","origin/main")
                files=set(git("diff","--name-only","origin/main..."+p["headRefOid"]).splitlines())
                overlap=[]
                for commit in git("log","origin/main","--first-parent","--since="+run["createdAt"],"--format=%H").splitlines():
                    common=files & set(git("diff","--name-only",commit+"^1",commit).splitlines())
                    if common: overlap.append({"commit":commit,"files":sorted(common)})
                result["overlaps"]=overlap
                if overlap:
                    # A main merge since the run touched this PR's files. The run still counts only when every file
                    # this PR changes is byte-identical between the tree the run tested and the tree a merge now
                    # would produce (e.g. the PR already contained that merge's exact head). Files the PR doesn't
                    # change may differ, as under the overlap rule above. Otherwise it is STALE.
                    base=tested_base(run["databaseId"],p["headRefOid"]);result["tested_base"]=base
                    then=merged_tree(base,p["headRefOid"]) if base else None
                    now=merged_tree(result["main"],p["headRefOid"])
                    if then and now:
                        mine=files|set(git("diff","--name-only",base,then).splitlines())
                        differ=set(git("diff","--name-only",then,now).splitlines())
                        result["differs_outside_pr"]=sorted(differ-mine)[:20]
                        result["pr_files_identical"]=not (differ & mine)
                result["verdict"]="STALE" if overlap and not result.get("pr_files_identical") else "GREEN"
(folder/("merge-check-"+number+".json")).write_text(json.dumps(result,indent=2))
print(json.dumps(result))
