set -u
cd /opt/ccc/repo
UNITENV=$(systemctl show cybersarah-ccc -p Environment --value)
EFILE=$(systemctl show cybersarah-ccc -p EnvironmentFiles --value | awk '{print $1}')
echo "EnvironmentFile: ${EFILE:-keins}"
echo "== JWT_SECRET: Unit vs. EnvironmentFile (nur Laenge + Hash-Praefix) =="
U=$(echo "$UNITENV" | tr ' ' '\n' | grep '^JWT_SECRET=' | cut -d= -f2-)
F=""; [ -n "${EFILE:-}" ] && [ -r "$EFILE" ] && F=$(grep '^JWT_SECRET=' "$EFILE" | cut -d= -f2- | tr -d '"')
P=$(tr '\0' '\n' < /proc/$(systemctl show cybersarah-ccc -p MainPID --value)/environ | grep '^JWT_SECRET=' | cut -d= -f2-)
for N in U F P; do V="${!N}"; printf "%s: len=%s sha=%s\n" "$N" "${#V}" "$(printf %s "$V" | sha256sum | cut -c1-8)"; done
echo "== VITE_APP_ID im Prozess =="
tr '\0' '\n' < /proc/$(systemctl show cybersarah-ccc -p MainPID --value)/environ | grep -c '^VITE_APP_ID=' 
echo "== getUserByOpenId im laufenden Code =="
grep -n "export async function getUserByOpenId" -A 8 server/db.ts | head -12
echo "== Token minten mit Prozess-Secret und pruefen =="
OID=$(sudo -u postgres psql -d cybersarah -At -c "SELECT \"openId\" FROM users WHERE email='niko.oeben@gmail.com' LIMIT 1")
cat > /tmp/probe.mts <<'TS'
import { sdk } from "/opt/ccc/repo/server/_core/sdk";
const t = await sdk.createSessionToken(process.env.OID!, { name: "probe" });
const v = await sdk.verifySession(t);
console.error("verifySession lokal:", v ? "OK openId-len=" + v.openId.length : "NULL");
const u = await sdk.authenticateRequest({ headers: { authorization: "Bearer " + t } } as any).catch((e: any) => "FEHLER: " + e.message);
console.error("authenticateRequest lokal:", typeof u === "string" ? u : "OK role=" + u.role);
TS
OID="$OID" JWT_SECRET="$P" DATABASE_URL="$(tr '\0' '\n' < /proc/$(systemctl show cybersarah-ccc -p MainPID --value)/environ | grep '^DATABASE_URL=' | cut -d= -f2-)" npx --yes tsx /tmp/probe.mts 2>&1 | grep -E "lokal|Error" | cut -c1-200
rm -f /tmp/probe.mts
