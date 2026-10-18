import os
"""Set org default plan config: autoContext off (gemma degenerates on the auto-context prompt)."""
import base64, hashlib, json, os, sys, urllib.request

AUTH = os.environ["PLANDEX_AUTH_JSON"]
BASE = os.environ.get("PLANDEX_BASE", "http://127.0.0.1:8099")

H = json.load(open(AUTH))
h = hashlib.sha256(("%s||%s||false" % (H["orgName"], "true" if H["orgIsTrial"] else "false")).encode()).hexdigest()
payload = {"token": H["token"], "orgId": H["orgId"], "hash": h}
hdr = "Bearer " + base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()

def req(method, path, body=None):
    r = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None,
                               headers={"Content-Type": "application/json", "Authorization": hdr}, method=method)
    resp = urllib.request.urlopen(r, timeout=30)
    out = resp.read().decode()
    if resp.status >= 400:
        sys.exit(out)
    return json.loads(out) if out.strip() else {}

cur = req("GET", "/default_plan_config")
cfg = cur.get("config") or {}
cfg["autoContext"] = False
cfg["autoUpdateContext"] = False
resp = req("PUT", "/default_plan_config", {"config": cfg})
print("PLANCONFIG-OK autoContext=false")
print(resp if resp else "")
