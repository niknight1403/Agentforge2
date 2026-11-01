set -u
echo "== Journal: users-Query-Fehler des laufenden Dienstes (letzte 30 Min) =="
journalctl -u cybersarah-ccc --since "-30 min" --no-pager 2>/dev/null | grep -iE 'Failed query|from "users"|column .* does not exist|relation .* does not exist|cause' | tail -6 | cut -c1-420
echo "== Spalten der Tabelle users =="
sudo -u postgres psql -d cybersarah -At -c "SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name='users' AND table_schema='public'"
echo "== Spalten, die der Code selektiert (drizzle/schema.ts users) =="
cd /opt/ccc/repo
awk '/export const users = pgTable/,/^\}\);/' drizzle/schema.ts | grep -oE '(varchar|text|integer|timestamp|serial|boolean|pgEnum|[a-zA-Z]+Role)\("[A-Za-z_]+"' | sed -E 's/.*\("//; s/"//' | paste -sd, | cut -c1-300
echo "== Migrationsstand (drizzle) =="
sudo -u postgres psql -d cybersarah -At -c "SELECT count(*), max(id) FROM drizzle.__drizzle_migrations" 2>&1 | head -2
ls drizzle/*.sql | tail -3
echo "== Login-Test ueber echte Route (Statuscode) =="
curl -s -m 10 -o /dev/null -w "account.login (falsches PW) -> HTTP %{http_code}\n" -H 'Content-Type: application/json' -d '{"json":{"email":"niko.oeben@gmail.com","password":"falsch-falsch-123"}}' http://127.0.0.1:13000/api/trpc/account.login
