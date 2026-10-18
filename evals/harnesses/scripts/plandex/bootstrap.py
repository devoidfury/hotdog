#!/usr/bin/env python3
import os
"""Non-interactive local-mode bootstrap: create account+org via HTTP API, seed auth.json."""
import base64, hashlib, json, os, sys, time, urllib.request

BASE = os.environ.get("PLANDEX_BASE", "http://127.0.0.1:8099")
EMAIL = os.environ.get("PLANDEX_EMAIL", "local-admin@plandex.ai")
NAME = os.environ.get("PLANDEX_NAME", "Local Admin")
ORG = os.environ.get("PLANDEX_ORG", "Local Org")
HOST = os.environ.get("PLANDEX_HOST", "http://localhost:8099")

def post(path, body, auth_hdr=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    if auth_hdr:
        req.add_header("Authorization", "Bearer " + auth_hdr)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        sys.stderr.write("HTTP %s on %s: %s\n" % (e.code, path, e.read().decode()[:500]))
        raise

def hdr(token, org_id, org_name):
    h = hashlib.sha256(("%s||%s||%s" % (org_name, "false" if not org_name == "?" else "", )).encode()) if False else None
    # replicate shared.ClientAuth.ToHash: sha256(orgName||fmtbool(orgIsTrial)||fmtbool(integratedModelsMode))
    h = hashlib.sha256(("%s||false||false" % org_name).encode()).hexdigest()
    payload = {"token": token, "orgId": org_id, "hash": h}
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()

def main():
    # wait for health
    for _ in range(60):
        try:
            urllib.request.urlopen(BASE + "/health", timeout=3).read()
            break
        except Exception:
            time.sleep(1)
    else:
        sys.exit("server never healthy")

    ev = post("/accounts/email_verifications", {"email": EMAIL, "userId": ""})
    has_account = ev.get("hasAccount", False)

    token = user_id = None
    orgs = []
    if not has_account:
        sess = post("/accounts", {"email": EMAIL, "pin": "", "userName": NAME})
        token, user_id, orgs = sess["token"], sess["userId"], sess.get("orgs") or []
    else:
        sess = post("/accounts/sign_in", {"email": EMAIL, "pin": "", "isSignInCode": False})
        token, user_id, orgs = sess["token"], sess["userId"], sess.get("orgs") or []

    org_id, org_name, is_trial = None, ORG, False
    if len(orgs) == 0:
        created = post("/orgs", {"name": ORG, "autoAddDomainUsers": False}, auth_hdr=hdr(token, "", ORG))
        org_id = created.get("id") or created.get("orgId")
    else:
        org_id, org_name, is_trial = orgs[0]["id"], orgs[0]["name"], orgs[0].get("isTrial", False)

    h = hashlib.sha256(("%s||%s||false" % (org_name, "true" if is_trial else "false")).encode()).hexdigest()
    auth = {
        "isCloud": False,
        "host": HOST,
        "email": EMAIL,
        "userName": NAME,
        "userId": user_id,
        "token": token,
        "isLocalMode": True,
        "isTrial": False,
        "orgId": org_id,
        "orgName": org_name,
        "orgIsTrial": is_trial,
        "integratedModelsMode": False,
    }
    out = os.environ.get("PLANDEX_AUTH_JSON")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(auth, f, indent=2)
    print("BOOTSTRAP-OK userId=%s orgId=%s" % (user_id, org_id))

if __name__ == "__main__":
    main()
