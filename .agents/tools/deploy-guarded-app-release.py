#!/usr/bin/env python3
"""Activate a built app release under the existing native upgrade guards."""
import argparse,ast,fcntl,hashlib,json,os,runpy,stat,subprocess,sys,time,uuid
from pathlib import Path
os.umask(0o077)
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("--config",type=Path,required=True)
parser.add_argument("--check",action="store_true")
args=parser.parse_args()
info=args.config.lstat()
assert args.config.is_absolute() and stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and not info.st_mode&0o077
c=json.loads(args.config.read_text());base=Path(c["appBase"]);release=Path(c["release"]);source=Path(c["source"]);home=Path(c["hermesHome"]);current=base/"current";operation=c["operationId"];lease=Path(c["maintenanceFile"]);drain=home/".drain_request.json";service_env=base/"shared/hermes-service.env";app_env=base/"shared/app.env";origin=c["appOrigin"]
ops=base/"operations"/("continued-"+operation);ops.mkdir(mode=0o700,exist_ok=True);log=(ops/"commands.log").open("a");claim=None
module=ast.parse(Path(__file__).with_name("deploy-app-release.py").read_text());module.body=[x for x in module.body if isinstance(x,(ast.Import,ast.ImportFrom,ast.FunctionDef))];exec(compile(module,"verified-deployment-functions","exec"))
parsed_origin=urlsplit(origin)
assert parsed_origin.scheme=="https" and parsed_origin.netloc and not parsed_origin.username
assert not parsed_origin.path and not parsed_origin.query and not parsed_origin.fragment
assert current.resolve()==Path(c["expectedRelease"])
assert release.parent==base/"releases" and release.is_dir() and not release.is_symlink() and release!=current.resolve()
assert all(p.is_absolute() for p in (base,release,source,home,lease))
assert str(uuid.UUID(operation))==operation
assert not lease.exists() and not drain.exists()
worker_lock=os.fdopen(os.open(Path(c["upgradeStateDir"])/"worker.lock",os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600),"w")
fcntl.flock(worker_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
old_state=Path(c["upgradeStateDir"])/"status.json"
state=json.loads(old_state.read_text())
assert state["phase"] not in ("checking","qualifying","installing","verifying") and state.get("maintenance") is False
assert all(json.loads(p.read_text()).get("status")=="complete" for p in (Path(c["upgradeStateDir"])/"requests").glob("*.json"))
(ops/"previous-status.json").write_bytes(old_state.read_bytes())
(ops/"previous-worker.json").write_bytes((base/"shared/hermes-worker.json").read_bytes())
assert hashlib.sha256((release/"scripts/hermes-upgrade-linux.py").read_bytes()).hexdigest()==c["fixedHelperSha256"]
assert c["webBuild"] in (release/"dist/client/sw.js").read_text()
configs=[Path(path) for path in c["profileHashes"]];hashes=lambda:{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in configs}
assert hashes()==c["profileHashes"]
qualification_target=Path(c["qualificationReceipt"])
qualification_input=Path(c.get("newQualificationReceipt",c["qualificationReceipt"]))
read_receipt=runpy.run_path(str(release/"src/hermes/qualification.py"))["read_receipt"]
qualified_receipt=read_receipt(qualification_input,release)
qualified_bytes=qualification_input.read_bytes()
assert json.loads(qualified_bytes)==qualified_receipt
assert qualified_receipt["revision"]==c["hermesRevision"] and qualified_receipt["trackedPatchSha256"]==c["repairSha256"]
assert qualification_target.is_absolute() and not qualification_target.is_symlink()
assert c["newWorkerConfig"]["qualificationReceipt"]==str(qualification_target)
for environment,key in ((service_env,"HERMES_AGENT_INTERFACE_QUALIFICATION_FILE"),(app_env,"HERMES_QUALIFICATION_FILE")):
 values=dict(line.split("=",1) for line in environment.read_text().splitlines() if "=" in line)
 assert values.get(key)==str(qualification_target)
def rpc(action):
 code="import runpy; m=runpy.run_path("+repr(str(release/"scripts/hermes-upgrade-linux.py"))+"); exec(m['NATIVE'])"
 secret=dict(line.split("=",1) for line in service_env.read_text().splitlines() if "=" in line)["HERMES_AGENT_INTERFACE_TOKEN"]
 req={"action":"rpc","source":str(source),"origin":"http://127.0.0.1:9119","key":secret,"operation":operation,"method":action}
 return json.loads(run([c["managedPython"],"-I","-c",code],input=json.dumps(req),timeout=40))
def gateway_idle(after=None):
 if not ready_gateway("draining"):return False
 record=gateway_state();updated=datetime.datetime.fromisoformat(record["updated_at"]).timestamp()
 return (type(record.get("active_agents")) is int and record["active_agents"]==0 and "active_work" in record
  and record["active_work"] in (None,[]) and 0<=time.time()-updated<=10 and (after is None or updated>after))
claim=runpy.run_path(str(release/"scripts/hermes-upgrade-worker.py"))["NativeUpdateClaim"](source,home)
opened=False
with claim:
 os.environ["HERMES_UPDATE_HANDOFF_PID"]=str(claim.owner_pid)
 assert run(["git","-C",str(source),"rev-parse","HEAD"]).strip()==c["hermesRevision"]
 assert hashlib.sha256(subprocess.check_output(["git","-C",str(source),"diff","HEAD","--binary"])).hexdigest()==c["repairSha256"]
 gate=rpc("status");assert gate["active"] is False and gate["busy"]==[]
 assert ready_gateway("running")
 record=gateway_state();assert type(record.get("active_agents")) is int and record["active_agents"]==0 and "active_work" in record and record["active_work"] in (None,[])
 assert 0<=time.time()-datetime.datetime.fromisoformat(record["updated_at"]).timestamp()<=120
 status=get_status();assert status["active_agents"]==status["active_sessions"]==0
 google();assert app_ready()
 if args.check:
  print(json.dumps({"nativeAndWorkerOwnership":True,"idleGatewayVerified":True,"originalGoogleVerified":True,"noServiceChanges":True}));sys.exit(0)
 try:
  state.update(phase="blocked",maintenance=True,operationId=operation,message="The installer is applying a verified app release.",updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
  atomic(old_state,(json.dumps(state)+"\n").encode())
  system("stop","agent-interface.service")
  assert all(json.loads(p.read_text()).get("status")=="complete" for p in (Path(c["upgradeStateDir"])/"requests").glob("*.json"))
  # Eliminate an already awaited API request racing the private status write.
  atomic(old_state,(json.dumps(state)+"\n").encode())
  journal("maintenance-acquiring")
  # The RPC may hold admission even if its response is lost. On any failure,
  # leave native owners running and retain the blocked state for diagnosis.
  gate=rpc("acquire");assert gate["active"] is True and gate["operationId"]==operation and gate["busy"]==[]
  assert json.loads(lease.read_text())=={"operationId":operation}
  journal("owned-maintenance-acquired")
  run([c["node"],str(release/".agents/tools/backup-app.mjs"),str(base/"shared/app.sqlite"),str(ops/"database")])
  request=json.loads(native("import json; from gateway.drain_control import write_drain_request; print(json.dumps(write_drain_request(principal="+repr(operation)+",suppress_notification=True)))"))
  requested_at=datetime.datetime.fromisoformat(request["requested_at"]).timestamp()
  wait(lambda:gateway_idle(requested_at),30)
  gate=rpc("status");assert gate["active"] is True and gate["operationId"]==operation and gate["busy"]==[]
  assert gateway_idle(requested_at)
  record=gateway_state();assert type(record.get("active_agents")) is int and record["active_agents"]==0 and "active_work" in record and record["active_work"] in (None,[])
  old_pid=int(pid("hermes-gateway.service"));stopped_at=time.time()
  system("stop","agent-interface.service","hermes-dashboard.service","hermes-gateway.service")
  assert pid("hermes-dashboard.service")==pid("hermes-gateway.service")=="0"
  verdict=dict(line.split("=",1) for line in system("show","hermes-gateway.service","--property=Result,ExecMainCode,ExecMainStatus").splitlines())
  assert verdict=={"Result":"success","ExecMainCode":"1","ExecMainStatus":"0"}
  assert (home/".clean_shutdown").stat().st_mtime>=stopped_at
  record=gateway_state();assert record["pid"]==old_pid and record["gateway_state"]=="stopped" and datetime.datetime.fromisoformat(record["updated_at"]).timestamp()>=stopped_at
  assert hashes()==c["profileHashes"]
  # Bind the new add-on only after all native readers stopped. Retain the
  # matching old receipt before replacing it; recovery restores both together.
  previous_qualification=qualification_target.read_bytes() if qualification_target.exists() else None
  atomic(ops/"previous-qualification-state.json",(json.dumps({"path":str(qualification_target),"existed":previous_qualification is not None,
    "sha256":hashlib.sha256(previous_qualification).hexdigest() if previous_qualification is not None else None})+"\n").encode())
  if previous_qualification is not None:atomic(ops/"previous-qualification.json",previous_qualification)
  atomic(qualification_target,qualified_bytes)
  atomic(base/"shared/hermes-worker.json",json.dumps(c["newWorkerConfig"],indent=2).encode()+b"\n")
  switch(release);journal("release-switched")
  system("start","hermes-dashboard.service","hermes-gateway.service","agent-interface.service")
  wait(lambda:ready_gateway("draining"));google();wait(app_ready)
  gate=rpc("status");assert gate["active"] is True and gate["operationId"]==operation and gate["busy"]==[]
  assert hashes()==c["profileHashes"]
  run([c["node"],"--env-file="+str(app_env),"--import","tsx","scripts/setup.ts","--check"],cwd=current)
  opened=True
  assert rpc("release")["active"] is False
  assert json.loads(drain.read_text())["principal"]==operation
  native("from gateway.drain_control import clear_drain_request; assert clear_drain_request()")
  wait(lambda:ready_gateway("running"));google();assert app_ready()
  atomic(Path(c["upgradeStateDir"])/"status.json",(json.dumps({"phase":"idle","maintenance":False,"checks":[],"current":{"revision":c["hermesRevision"],"version":c["hermesRevision"][:12],"notesUrl":"https://github.com/NousResearch/hermes-agent/commit/"+c["hermesRevision"]},"message":"Check for a Hermes update when you're ready.","updatedAt":datetime.datetime.now(datetime.timezone.utc).isoformat()})+"\n").encode())
  result={"webBuild":c["webBuild"],"hermesRevision":c["hermesRevision"],"hermesVersionUnchanged":True,"repairPreserved":True,"profileSettingsPreserved":True,"originalGoogleHttpAndFreshWebsocket":True,"gatewayGuardVerified":True,"bothDiscordConnected":True,"actualInstallerMaintenanceRpc":True}
  atomic(ops/"result.json",(json.dumps(result,indent=2)+"\n").encode());journal("complete");print(json.dumps(result))
 except BaseException:
  import traceback;traceback.print_exc(file=log);log.flush();journal("admission-needs-review" if opened else "maintenance-held-needs-review");print("Release activation needs review; native owners preserved and private phase recorded.");sys.exit(2)
 finally:log.close();worker_lock.close()
