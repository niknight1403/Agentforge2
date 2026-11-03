#!/usr/bin/env bash
# Atomically replace only AnfragePilot application source; never touch data, secrets or nginx.
set -Eeuo pipefail
ROOT=/opt/anfragepilot
ARCHIVE=/tmp/anfragepilot-source-release.tgz
SERVICE=anfragepilot.service
[ "$(id -u)" -eq 0 ] || { echo "Requires root"; exit 1; }
[ -f "$ROOT/pilot.env" ] && [ -d "$ROOT/data" ] && [ -d "$ROOT/node_modules" ] || {
  echo "Existing pilot installation/dependencies missing; aborting"; exit 1;
}
STAGE=$(mktemp -d /opt/.anfragepilot-release-stage.XXXXXX)
BACKUP=$(mktemp -d /opt/.anfragepilot-release-backup.XXXXXX)
CHANGED=0
rollback() {
  status=$?
  trap - ERR
  if [ "$CHANGED" -eq 1 ]; then
    echo "::error::Release validation failed; restoring previous application source"
    for part in src public; do
      if [ -d "$BACKUP/$part" ]; then
        rm -rf "$ROOT/$part"
        mv "$BACKUP/$part" "$ROOT/$part"
      fi
    done
    systemctl restart "$SERVICE" || true
  fi
  rm -rf "$STAGE"
  exit "$status"
}
trap rollback ERR
tar -xzf "$ARCHIVE" -C "$STAGE"
for part in src public; do
  test -d "$STAGE/$part"
  test -d "$ROOT/$part"
done
for file in src/server.js src/billing.js src/db.js src/auth.js; do
  node --check "$STAGE/$file"
done
CHANGED=1
for part in src public; do
  mv "$ROOT/$part" "$BACKUP/$part"
  mv "$STAGE/$part" "$ROOT/$part"
  chown -R ubuntu:ubuntu "$ROOT/$part"
done
systemctl restart "$SERVICE"
READY=0
for attempt in $(seq 1 12); do
  if systemctl is-active --quiet "$SERVICE" &&
    curl --fail --silent --max-time 4 http://127.0.0.1:3910/api/health > /tmp/pilot-release-health.json &&
    curl --fail --silent --max-time 4 http://127.0.0.1:3910/api/plans > /tmp/pilot-release-plans.json; then
    READY=1
    break
  fi
  sleep 2
done
test "$READY" -eq 1
node -e "const h=require('/tmp/pilot-release-health.json');if(h.ok!==true||h.service!=='anfragepilot')throw Error('wrong health response');const p=require('/tmp/pilot-release-plans.json');if(!Array.isArray(p.plaene)||!p.plaene.some(x=>x.key==='trial'))throw Error('wrong plans response')"
for file in src/server.js src/billing.js src/db.js public/dashboard.html; do
  sha256sum "$ROOT/$file"
done
echo "PILOT_CODE_DEPLOY_OK"
trap - ERR
rm -rf "$STAGE"
echo "Rollback copy retained: $BACKUP"
