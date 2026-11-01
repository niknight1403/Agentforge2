set -u
PID=$(systemctl show cybersarah-ccc -p MainPID --value)
RU=$(tr '\0' '\n' < /proc/$PID/environ | grep '^REVENUE_OS_DATABASE_URL=' | cut -d= -f2-)
echo "REVENUE_OS_DATABASE_URL: $(echo "$RU" | sed -E 's#(://)[^@]+@#\1***@#')"
ROLE=$(echo "$RU" | sed -E 's#^[a-z]+://([^:@]+)[:@].*#\1#'); echo "Rolle: $ROLE"
echo "== Verbindung mit Dienst-URL =="
PGCONNECT_TIMEOUT=8 psql "$RU" -At -c "SELECT current_database(), current_user, (SELECT count(*) FROM angebote)" 2>&1 | head -2 | cut -c1-220
echo "== Rechte der Rolle auf revenue_os =="
sudo -u postgres psql -d revenue_os -At -c "SELECT has_schema_privilege('$ROLE','public','USAGE'), has_table_privilege('$ROLE','public.angebote','SELECT'), has_table_privilege('$ROLE','public.kunden','SELECT')" 2>&1 | head -2
echo "== Tabellen-Owner =="
sudo -u postgres psql -d revenue_os -At -c "SELECT tableowner, count(*) FROM pg_tables WHERE schemaname='public' GROUP BY 1"
echo "== Fehler im Journal =="
journalctl -u cybersarah-ccc --since "-5 min" --no-pager 2>/dev/null | grep -iE "Revenue-Datenabfrage|revenue" | tail -3 | cut -c1-220
