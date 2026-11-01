echo "== users (Rolle/Methode, ohne Hash) =="
sudo -u postgres psql -d cybersarah -At -c "SELECT id, left(\"openId\",10)||'...', email, role, \"loginMethod\" FROM users ORDER BY id"
echo "== Unit-Env: relevante Namen =="
systemctl show cybersarah-ccc -p Environment --value | tr ' ' '\n' | cut -d= -f1 | grep -E 'PORT|VITE_APP_ID|JWT_SECRET|OWNER|ADMIN'
echo "== Auth-Warnungen im Journal (10 Min) =="
journalctl -u cybersarah-ccc --since "-10 min" --no-pager 2>/dev/null | grep -E "\[Auth\]|Invalid session" | tail -8 | cut -c1-200
echo "== wie wird role gesetzt? =="
grep -n "OWNER_OPEN_ID\|role = 'admin'\|role: \"admin\"" /opt/ccc/repo/server/db.ts | head -6
