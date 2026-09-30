package dev.villaforge.app.net

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.concurrent.TimeUnit

/**
 * SSE-Client fuer den Hub-Ereignisstrom (`GET /api/events`).
 *
 * Der Hub haelt die Verbindung offen (`text/event-stream`) und sendet je
 * Ereignis `data: {json}`; Kommentare wie `: ping` halten die Verbindung
 * am Leben, `retry: 3000` nennt einen Wunsch-Rückverbindungsrhythmus.
 *
 * Dieser Client verbindet sich automatisch, liest zeilenweise, informiert
 * ueber Verbindungswechsel und verbindet nach Fehlern selbststaendig neu
 * (Backoff 1s → 2S → 4s → … max 15s; zurueckgesetzt nach dem ersten
 * empfangenen Event). stop() schliesst die Verbindung sauber.
 */
class SseClient(
    private val urlProvider: () -> String,
    private val scope: CoroutineScope,
    private val onEvent: (VillaEvent) -> Unit,
    private val onConnectionChange: (Boolean) -> Unit
) {

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS) // SSE: Verbindung bleibt offen
        .retryOnConnectionFailure(true)
        .build()

    private var job: Job? = null

    /** Aktuell offener Call, damit stop() die blockierende Verbindung schliesst. */
    @Volatile
    private var activeCall: Call? = null

    /** Startet den Strom (idempotent — ein laufender Strom bleibt unberuehrt). */
    fun start() {
        if (job?.isActive == true) return
        job = scope.launch(Dispatchers.IO) {
            var backoffMs = INITIAL_BACKOFF_MS
            while (isActive) {
                try {
                    connect { event ->
                        backoffMs = INITIAL_BACKOFF_MS // Events empfangen: sofort neu verbinden duerfen
                        onEvent(event)
                    }
                } catch (_: Exception) {
                    // Netzwerkfehler, Server-Neustart: einfach neu verbinden.
                } finally {
                    onConnectionChange(false)
                }
                if (!isActive) break
                delay(backoffMs)
                backoffMs = (backoffMs * 2).coerceAtMost(MAX_BACKOFF_MS)
            }
        }
    }

    /** Stoppt den Strom und meldet „getrennt“. */
    fun stop() {
        job?.cancel()
        job = null
        activeCall?.cancel()
        activeCall = null
        onConnectionChange(false)
    }

    /**
     * Baut EINE Verbindung auf und liest sie bis zum Abbruch aus.
     * Rueckgabe normal nur bei Verbindungsabbruch; wirft bei Netzwerkfehlern.
     */
    private fun connect(handle: (VillaEvent) -> Unit) {
        val url = urlProvider().trimEnd('/') + "/api/events"
        val request = Request.Builder().url(url).header("Accept", "text/event-stream").build()
        val call = http.newCall(request)
        activeCall = call
        try {
            call.execute().use { response ->
                if (!response.isSuccessful) throw HubException(response.code, "SSE nicht verfuegbar")
                val source = response.body ?: throw HubException(response.code, "SSE-Body leer")
                onConnectionChange(true) // Stream steht: jetzt ist der Hub live
                val reader = BufferedReader(InputStreamReader(source.byteStream(), Charsets.UTF_8))
                val dataLines = StringBuilder()
                while (scope.isActive) {
                    val line = reader.readLine() ?: break // Verbindung zuende
                    when {
                        line.isEmpty() -> {
                            // Leerzeile schliesst ein Event ab.
                            val data = dataLines.toString()
                            if (data.isNotBlank()) {
                                VillaEvent.parse(data)?.let(handle)
                            }
                            dataLines.setLength(0)
                        }
                        line.startsWith(":") -> Unit // Kommentar/Ping ignorieren
                        line.startsWith("data:") -> dataLines.append(line.removePrefix("data:").trim())
                        else -> Unit // retry:/event:/id: aktuell ohne Semantik
                    }
                }
            }
        } finally {
            activeCall = null
        }
    }

    companion object {
        private const val INITIAL_BACKOFF_MS = 1_000L
        private const val MAX_BACKOFF_MS = 15_000L
    }
}
