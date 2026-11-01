set -u
PID=$(systemctl show cybersarah-ccc -p MainPID --value)
DBU=$(tr '\0' '\n' < /proc/$PID/environ | grep '^DATABASE_URL=' | cut -d= -f2-)
ROLE=$(echo "$DBU" | sed -E 's#^[a-z]+://([^:@]+)[:@].*#\1#')
echo "Dienst-Rolle: $ROLE"
echo "== Wo liegen die users-Tabellen? =="
sudo -u postgres psql -d cybersarah -At -c "SELECT schemaname||'.'||tablename||' (owner '||tableowner||')' FROM pg_tables WHERE tablename='users'"
echo "== Rollen-Setup =="
sudo -u postgres psql -d cybersarah -At -c "SELECT rolname, rolsuper, rolconfig FROM pg_roles WHERE rolname='$ROLE'"
echo "== search_path (DB / Rolle / Session des Dienstes) =="
sudo -u postgres psql -d cybersarah -At -c "SHOW search_path"
PGCONNECT_TIMEOUT=8 psql "$DBU" -At -c "SHOW search_path" 2>&1 | head -1
PGCONNECT_TIMEOUT=8 psql "$DBU" -At -c "SELECT current_schemas(true)" 2>&1 | head -1
echo "== Rechte der Dienst-Rolle auf public =="
sudo -u postgres psql -d cybersarah -At -c "SELECT has_schema_privilege('$ROLE','public','USAGE') AS usage, has_table_privilege('$ROLE','public.users','SELECT') AS sel"
echo "== Gibt es mehrere Datenbanken? =="
sudo -u postgres psql -At -c "SELECT datname FROM pg_database WHERE NOT datistemplate"
echo "== Welche DB sieht die Dienst-Rolle? =="
PGCONNECT_TIMEOUT=8 psql "$DBU" -At -c "SELECT current_database(), (SELECT count(*) FROM information_schema.tables WHERE table_schema='public')" 2>&1 | head -1
