#!/usr/bin/env python3
# nginx: Route /ccc/ in den hub.cybersarah-ki.com-Serverblock einfuegen (idempotent).
import glob

files = []
for pat in ("/etc/nginx/sites-enabled/*", "/etc/nginx/conf.d/*.conf", "/etc/nginx/nginx.conf"):
    files += [f for f in glob.glob(pat)]
target = None
for f in files:
    try:
        txt = open(f).read()
    except Exception:
        continue
    if "hub.cybersarah-ki.com" in txt and "location /ccc/" not in txt:
        target = (f, txt)
        break
if target is None:
    print("nginx: Route existiert bereits oder Host nicht gefunden - nichts zu tun.")
else:
    f, txt = target
    idx = txt.find("hub.cybersarah-ki.com")
    start = txt.rfind("server {", 0, idx)
    if start == -1:
        raise SystemExit("server-Block nicht gefunden")
    depth, i = 0, None
    k = txt.find("{", start)
    while k < len(txt):
        if txt[k] == "{":
            depth += 1
        elif txt[k] == "}":
            depth -= 1
            if depth == 0:
                i = k
                break
        k += 1
    if i is None:
        raise SystemExit("server-Block-Klammer nicht ausgeglichen")
    location = """
    # CCC-VM-Stack (2026-10-21): CyberSarah API auf der VM, Neon-unabhaengig.
    location /ccc/ {
        proxy_pass http://127.0.0.1:13000/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
"""
    newtxt = txt[:i] + location + txt[i:]
    open(f, "w").write(newtxt)
    print("nginx: Route in %s eingefuegt." % f)
