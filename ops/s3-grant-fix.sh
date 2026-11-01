set -u
echo "== VORHER: sichtbare Tabellen fuer ccc =="
sudo -u postgres psql -d cybersarah -At -c "SELECT has_schema_privilege('ccc','public','USAGE')"
echo "== Rechte setzen (nur GRANT, keine Datenaenderung) =="
sudo -u postgres psql -d cybersarah -v ON_ERROR_STOP=1 <<'SQL'
GRANT USAGE ON SCHEMA public TO ccc;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ccc;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ccc;
ALTER DEFAULT PRIVILEGES FOR ROLE ccc_app IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ccc;
ALTER DEFAULT PRIVILEGES FOR ROLE ccc_app IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ccc;
SQL
echo "== NACHHER =="
sudo -u postgres psql -d cybersarah -At -c "SELECT has_schema_privilege('ccc','public','USAGE'), has_table_privilege('ccc','public.users','SELECT'), has_table_privilege('ccc','public.\"aiAufgaben\"','INSERT')"
PID=$(systemctl show cybersarah-ccc -p MainPID --value)
DBU=$(tr '\0' '\n' < /proc/$PID/environ | grep '^DATABASE_URL=' | cut -d= -f2-)
echo "== Dienst-Rolle sieht jetzt: =="
PGCONNECT_TIMEOUT=8 psql "$DBU" -At -c "SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM \"aiAgenten\") AS agenten"
echo "== Neustart + Health =="
systemctl restart cybersarah-ccc; sleep 20
curl -s -m 8 http://127.0.0.1:13000/api/ready | head -c 160; echo
echo "== Fehler seit Neustart (soll leer sein) =="
journalctl -u cybersarah-ccc --since "-1 min" --no-pager 2>/dev/null | grep -cE 'Failed query|does not exist'
