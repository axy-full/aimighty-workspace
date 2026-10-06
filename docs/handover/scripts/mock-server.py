import os, sys, json, signal, socket, subprocess, time
from pathlib import Path
folder=Path(__file__).resolve().parent
mode,name=sys.argv[1:3]
record=folder/(name+"-server.json")
if mode=="stop":
    r=json.loads(record.read_text())
    parent=r["pid"]
    ps=subprocess.run(["ps","-p",str(parent),"-o","command="],text=True,capture_output=True)
    if ps.returncode or "node_modules/next/dist/bin/next dev" not in ps.stdout:
        print("Recorded server is no longer running");sys.exit(0)
    children=subprocess.run(["pgrep","-P",str(parent)],text=True,capture_output=True)
    for pid in [int(s) for s in children.stdout.split()]+[parent]:
        try: os.kill(pid,signal.SIGTERM);print("Stopped own process",pid)
        except ProcessLookupError: pass
    r["stopped"]=True;record.write_text(json.dumps(r,indent=2));sys.exit(0)
repo=Path(sys.argv[3]).resolve();port=int(sys.argv[4]);webpack=len(sys.argv)>5 and sys.argv[5]=="webpack"
if record.exists() and not json.loads(record.read_text()).get("stopped"):
    raise SystemExit("An owned server record is active; stop it before starting another")
def _busy(host,fam):
    try:
        with socket.socket(fam) as s:
            s.settimeout(0.5); return s.connect_ex((host,port))==0
    except OSError: return False
if _busy("127.0.0.1",socket.AF_INET) or _busy("::1",socket.AF_INET6): raise SystemExit("Port occupied; no existing process stopped")
data=Path("/private/tmp/particl-suites")/name;data.mkdir(parents=True,exist_ok=True)
env={k:v for k,v in os.environ.items() if k in ["PATH","HOME","TMPDIR","LANG","LC_ALL"]}
env.update(ENGINE_MOCK="1",NODE_ENV="development",APP_ORIGIN=f"http://localhost:{port}",PLATFORM_DATABASE_URL=f"file:{data}/platform.db",TURSO_DATABASE_URL=f"file:{data}/legacy.db",WORKSPACE_DB_DIRECTORY=str(data/"tenants"),PAYMENT_PROVIDER="manual",NEXT_TELEMETRY_DISABLED="1",CI_DEV_SOURCE_MAPS="off",SUPER_ADMIN_EMAIL="platform-owner@example.test")
# Same keep-alive preload CI uses (verify.yml): without it Node closes idle sockets at ~6 s and a
# Playwright request context reusing one fails with ECONNRESET.
keep_alive=repo/"scripts"/"ci-keep-alive.mjs"
if keep_alive.exists(): env["NODE_OPTIONS"]=f"--import {keep_alive}"
args=["node","node_modules/next/dist/bin/next","dev"]+(["--webpack"] if webpack else [])+["-p",str(port),"-H","localhost"]
with (folder/(name+"-dev.log")).open("a") as log:
    process=subprocess.Popen(args,cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
r={"pid":process.pid,"cwd":str(repo),"port":port,"database":str(data),"stopped":False}
record.write_text(json.dumps(r,indent=2));print(json.dumps(r))
