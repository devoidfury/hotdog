#!/usr/bin/env python3
import os
"""Set org-wide default model pack to the gateway pack via the server API."""
import base64, hashlib, json, os, sys, urllib.request

AUTH = os.environ["PLANDEX_AUTH_JSON"]
BASE = os.environ.get("PLANDEX_BASE", "http://127.0.0.1:8099")
PACK = os.environ.get("PLANDEX_PACK", "gw")

H = json.load(open(AUTH))
h = hashlib.sha256(("%s||%s||false" % (H["orgName"], "true" if H["orgIsTrial"] else "false")).encode()).hexdigest()
payload = {"token": H["token"], "orgId": H["orgId"], "hash": h}
hdr = "Bearer " + base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
req = urllib.request.Request(BASE + "/default_settings",
    data=json.dumps({"modelPackName": PACK}).encode(),
    headers={"Content-Type": "application/json", "Authorization": hdr}, method="PUT")
r = urllib.request.urlopen(req, timeout=30)
body = r.read().decode()
if r.status >= 400:
    sys.exit(body)
print(body)
