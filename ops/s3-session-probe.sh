set -u
PID=$(systemctl show cybersarah-ccc -p MainPID --value)
DBU=$(tr '\0' '\n' < /proc/$PID/environ | grep '^DATABASE_URL=' | cut -d= -f2-)
echo "== DATABASE_URL des Prozesses (ohne Zugangsdaten) =="
echo "$DBU" | sed -E 's#(://)[^@]+@#\1***@#'
echo "== Ursache (cause) im Journal =="
journalctl -u cybersarah-ccc --since "-15 min" --no-pager 2>/dev/null | grep -iE 'ECONNREFUSED|ENOTFOUND|self.signed|certificate|password authentication|no pg_hba|timeout|SSL|role .* does not exist|permission denied|cause' | sort -u | tail -6 | cut -c1-300
echo "== Postgres lauscht? =="
ss -ltn | grep -E ':5432|:443 ' | awk '{print $4}'
echo "== Direkter Test mit der URL des Prozesses (psql) =="
PGCONNECT_TIMEOUT=8 psql "$DBU" -At -c "SELECT current_user, inet_server_addr(), (SELECT count(*) FROM users)" 2>&1 | head -3 | cut -c1-250
echo "== Test ueber Node/pg wie der Dienst (SSL-Variante) =="
cd /opt/ccc/repo
cat > /tmp/dbt.cjs <<'JS'
const { Pool } = require("/opt/ccc/repo/node_modules/pg");
const raw = process.env.DBU;
const url = raw.replace(/[?&]sslmode=[^&]*/g, "");
const ssl = /sslmode=disable/.test(raw) ? false : { rejectUnauthorized: false };
const p = new Pool({ connectionString: url, ssl, max: 1, connectionTimeoutMillis: 8000 });
p.query("select count(*) as n from users").then(r => { console.log("pg OK users =", r.rows[0].n); return p.end(); })
 .catch(e => { console.log("pg FEHLER:", e.code || "", (e.message || "").slice(0, 160)); return p.end(); });
JS
DBU="$DBU" node /tmp/dbt.cjs; rm -f /tmp/dbt.cjs
