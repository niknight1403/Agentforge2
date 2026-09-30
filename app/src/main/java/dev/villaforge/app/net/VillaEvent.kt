package dev.villaforge.app.net

import org.json.JSONObject

/**
 * Ein Live-Ereignis aus dem SSE-Strom des Hubs (`GET /api/events`).
 *
 * Der Hub sendet pro Ereignis eine Zeile `data: {"type": …, "ts": …, …}`.
 * Die Typen sind: `villa` (Statuswechsel), `task` (Aufgabe laeuft/fertig/
 * fehlgeschlagen), `progress` (Durchlaufs-Fortschritt), `report` (Bericht
 * erstellt) und `tool` (Werkzeugaufruf). Alle Events tragen `villaId`.
 */
data class VillaEvent(
    val type: String,
    val ts: Long,
    val villaId: Long?,
    val text: String
) {
    companion object {

        /**
         * Reiner Parser: aus dem JSON-Body eines SSE-Events ein VillaEvent.
         * Ungueltige oder unvollstaendige Events werden zu null (der Strom
         * soll durch ein kaputtes Einzelevent nie abbrechen).
         */
        fun parse(json: String): VillaEvent? {
            return try {
                val o = JSONObject(json)
                val type = o.optString("type")
                if (type.isBlank()) return null
                VillaEvent(
                    type = type,
                    ts = o.optLong("ts", 0L),
                    villaId = if (o.has("villaId") && !o.isNull("villaId")) o.optLong("villaId") else null,
                    text = format(type, o)
                )
            } catch (_: Exception) {
                null
            }
        }

        /** Menschenlesbarer Einzeiler je Event-Typ (kompakt fuer Ticker). */
        private fun format(type: String, o: JSONObject): String = when (type) {
            "villa" -> {
                val status = o.optString("status")
                buildString {
                    append("Villa ")
                    if (status.isNotBlank()) append("→ $status ")
                    if (o.has("agents")) append("· ${o.optInt("agents")} Agenten ")
                    if (o.has("processed")) append("· ${o.optInt("processed")} Aufgaben verarbeitet ")
                    if (o.has("error")) append("· ${o.optString("error").take(80)}")
                }.trim()
            }
            "task" -> {
                val title = o.optString("title")
                val status = o.optString("status")
                if (title.isNotBlank()) "Aufgabe „$title“ → $status" else "Aufgabe → $status"
            }
            "progress" -> {
                buildString {
                    if (o.has("verification")) append("Prüfung ${o.optString("verification")} · ")
                    append("${o.optInt("processed")} Aufgaben verarbeitet")
                    if (o.has("round")) append(" · Runde ${o.optInt("round")}/${o.optInt("maxRounds")}")
                }
            }
            "report" -> {
                val kind = o.optString("kind")
                if (kind.isNotBlank()) "Bericht erstellt: $kind" else "Bericht erstellt"
            }
            "tool" -> "Werkzeug: ${o.optString("tool")}"
            else -> type
        }
    }
}
