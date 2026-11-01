set -u
echo "== Read-only-Rechte fuer ccc auf revenue_os (nur USAGE + SELECT) =="
sudo -u postgres psql -d revenue_os -v ON_ERROR_STOP=1 -q <<'SQL'
GRANT USAGE ON SCHEMA public TO ccc;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ccc;
ALTER DEFAULT PRIVILEGES FOR ROLE ccc_app IN SCHEMA public GRANT SELECT ON TABLES TO ccc;
SQL
sudo -u postgres psql -d revenue_os -At -c "SELECT has_schema_privilege('ccc','public','USAGE') AS usage, has_table_privilege('ccc','public.angebote','SELECT') AS lesen, has_table_privilege('ccc','public.angebote','INSERT') AS schreiben"
PID=$(systemctl show cybersarah-ccc -p MainPID --value)
RU=$(tr '\0' '\n' < /proc/$PID/environ | grep '^REVENUE_OS_DATABASE_URL=' | cut -d= -f2-)
PGCONNECT_TIMEOUT=8 psql "$RU" -At -c "SELECT 'angebote='||(SELECT count(*) FROM angebote)||' kunden='||(SELECT count(*) FROM kunden)"
