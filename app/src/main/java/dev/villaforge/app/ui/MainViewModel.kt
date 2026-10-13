package dev.villaforge.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.villaforge.app.net.ChatMessage
import dev.villaforge.app.net.HubClient
import dev.villaforge.app.net.LlmRoute
import dev.villaforge.app.net.SseClient
import dev.villaforge.app.net.Villa
import dev.villaforge.app.net.VillaDetail
import dev.villaforge.app.net.VillaEvent
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class UiState(
    val serverUrl: String = HubClient.DEFAULT_BASE,
    val online: Boolean = false,
    val healthText: String = "verbinde …",
    /** SSE-Verbindung zum Hub aktiv (Live-Ereignisse fließen). */
    val live: Boolean = false,
    /** Letzte Live-Ereignisse (neueste zuerst, begrenzt). */
    val events: List<VillaEvent> = emptyList(),
    val villas: List<Villa> = emptyList(),
    val detail: VillaDetail? = null,
    val messages: List<ChatMessage> = emptyList(),
    val routes: List<LlmRoute> = emptyList(),
    val busy: Boolean = false,
    val message: String = "",
    val error: String? = null,
    /** Hub-Statistik aus GET /api/stats, null bis geladen. */
    val stats: org.json.JSONObject? = null,
    /** Rat der Agenten: letzte Runden aus GET /api/villas/:id/council. */
    val council: org.json.JSONArray? = null,
    /** Marktreife/Phasen der offenen Villa aus GET /api/villas/:id/product, null bis geladen. */
    val product: org.json.JSONObject? = null,
    /** true = Hub nicht erreichbar, angezeigte Daten stammen aus dem Offline-Cache. */
    val stale: Boolean = false,
    /** Hub verlangt Anmeldung (HTTP 401 ohne gespeicherte Zugangsdaten): Login-Screen zeigen. */
    val needsLogin: Boolean = false
)

class MainViewModel(app: Application) : AndroidViewModel(app) {

    private val client = HubClient(app)
    private val _state = MutableStateFlow(UiState(serverUrl = client.serverUrl))
    val state: StateFlow<UiState> = _state.asStateFlow()

    /** Live-Ereignisstrom des Hubs (SSE), mit automatischem Nachverbinden. */
    private var sse: SseClient? = null

    /** Debounce fuer SSE-getriebene Detail-Aktualisierung. */
    private var liveRefreshJob: Job? = null

    init {
        loadSnapshot()
        startEventStream()
        refreshAll()
    }

    /** Offline-Fallback: letzten bekannten Villenstand sofort anzeigen, bevor der Hub antwortet. */
    private fun loadSnapshot() {
        val cached = client.villasFromCache() ?: return
        _state.update { it.copy(villas = cached, stale = true, healthText = "verbinde … (zeige letzten Stand)") }
    }

    override fun onCleared() {
        sse?.stop()
        sse = null
        liveRefreshJob?.cancel()
        super.onCleared()
    }

    /** Verbindet den SSE-Strom (neu), sofern noch nicht verbunden. */
    private fun startEventStream() {
        sse?.stop()
        val stream = SseClient(
            urlProvider = { client.baseUrl },
            tokenProvider = { client.apiToken },
            scope = viewModelScope,
            onEvent = { event -> onLiveEvent(event) },
            onConnectionChange = { connected ->
                _state.update { it.copy(live = connected) }
            }
        )
        sse = stream
        stream.start()
    }

    /**
     * Ein Live-Event ist eingetroffen: im Feed sammeln und, wenn es die
     * aktuell offene Villa betrifft, deren Detail-Datensaetze kurz darauf
     * frisch laden (debounced, damit ein Durchlauf mit vielen Events die
     * API nicht flutet).
     */
    private fun onLiveEvent(event: VillaEvent) {
        _state.update { it.copy(events = (listOf(event) + it.events).take(MAX_EVENTS)) }
        val openVilla = _state.value.detail?.villa?.id
        if (openVilla != null && (event.villaId == null || event.villaId == openVilla)) {
            liveRefreshJob?.cancel()
            liveRefreshJob = viewModelScope.launch {
                delay(1_200)
                refreshDetailSilently()
            }
        }
    }

    /** Wie refreshDetail(), aber ohne den busy-Indikator (im Hintergrund). */
    private fun refreshDetailSilently() {
        viewModelScope.launch {
            try {
                val detail = _state.value.detail ?: return@launch
                val refreshed = client.villaDetail(detail.villa.id)
                val prod = fetchProduct(detail.villa.id)
                _state.update { it.copy(detail = refreshed, product = prod) }
            } catch (_: Exception) {
                // Hintergrund-Aktualisierung darf nie abbrechen.
            }
        }
    }

    private fun run(block: suspend () -> Unit) {
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null) }
            try {
                block()
            } catch (e: dev.villaforge.app.net.HubException) {
                if (e.code == 401) {
                    _state.update { it.copy(needsLogin = true, error = null, healthText = "Anmeldung erforderlich") }
                } else {
                    _state.update { it.copy(error = e.message ?: "Unbekannter Fehler") }
                }
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Unbekannter Fehler") }
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    fun refreshAll() = run {
        val health = client.health()
        val villas = client.villas()
        val routes = client.routes()
        val hubStats = try { client.stats() } catch (e: Exception) { null }
        _state.update {
            it.copy(
                online = true,
                needsLogin = false,
                stale = false,
                healthText = "Hub online · ${health.optInt("routes")} Routen · v${health.optString("version")}",
                stats = hubStats,
                villas = villas,
                routes = routes
            )
        }
    }

    /** Laedt die letzten Rat-Runden der Villa in den Zustand. */
    fun refreshCouncil(villaId: Long) = run {
        val council = client.council(villaId)
        _state.update { it.copy(council = council) }
    }

    /** Beruft eine neue Rat-Runde ein und laedt die Runden danach neu. */
    fun triggerCouncil(villaId: Long) = run {
        client.councilTrigger(villaId)
        val council = client.council(villaId)
        _state.update { it.copy(council = council) }
    }

    /** Meldet mit E-Mail und Passwort am Hub an, verbindet SSE neu und laedt alles. */
    fun login(email: String, password: String) = run {
        try {
            client.login(email, password)
        } catch (e: dev.villaforge.app.net.HubException) {
            throw Exception(if (e.code == 401 || e.code == 403) "E-Mail oder Passwort falsch." else e.message)
        }
        _state.update { it.copy(message = "Angemeldet als ${email.trim()}", error = null, needsLogin = false) }
        startEventStream()
        refreshAll()
    }

    fun logout() {
        client.logout()
        _state.update { it.copy(message = "Abgemeldet") }
    }

    val loggedInEmail: String get() = client.loginEmail

    /** Speichert den optionalen Hub-Token und verbindet SSE neu. */
    fun saveApiToken(token: String) {
        client.apiToken = token
        startEventStream()
        refreshAll()
    }

    fun saveServerUrl(url: String) {
        client.baseUrl = url
        _state.update { it.copy(serverUrl = client.serverUrl) }
        startEventStream() // SSE auf die neue Hub-Adresse umziehen
        refreshAll()
    }

    fun createVilla(name: String, idea: String, agentCount: Int, sourcePath: String = "", onCreated: (Long) -> Unit) = run {
        val id = client.createVilla(name.ifBlank { "Neue Villa" }, idea, agentCount, sourcePath)
        val note = if (sourcePath.isBlank()) "Villa #$id erstellt – Chat geöffnet"
        else "Villa #$id erstellt, Projekt analysiert – Chat geöffnet"
        _state.update { it.copy(message = note) }
        refreshAll()
        onCreated(id)
    }

    /** Laesst die Agenten das hinterlegte Projekt erneut untersuchen. */
    fun analyze() = run {
        val detail = _state.value.detail ?: return@run
        if (detail.villa.sourcePath.isBlank()) {
            _state.update { it.copy(error = "Kein Quellprojekt hinterlegt. Erst unter Quelle einen Pfad speichern.") }
            return@run
        }
        client.analyze(detail.villa.id)
        _state.update { it.copy(message = "Analyse läuft …") }
        kotlinx.coroutines.delay(6000)
        val refreshed = client.villaDetail(detail.villa.id)
        _state.update { it.copy(detail = refreshed, message = "Analyse abgeschlossen") }
    }

    fun setSource(path: String) = run {
        val detail = _state.value.detail ?: return@run
        client.setSource(detail.villa.id, path)
        val refreshed = client.villaDetail(detail.villa.id)
        _state.update { it.copy(detail = refreshed, message = "Quellprojekt gespeichert") }
    }

    fun openVilla(id: Long) = run {
        val detail = client.villaDetail(id)
        val rootId = detail.agents.firstOrNull { it.isRoot }?.id ?: detail.agents.firstOrNull()?.id
        val msgs = client.messages(id, rootId)
        val prod = fetchProduct(id)
        _state.update { it.copy(detail = detail, messages = msgs, product = prod) }
    }

    fun sendChat(message: String) = run {
        val detail = _state.value.detail ?: return@run
        val rootId = detail.agents.firstOrNull { it.isRoot }?.id ?: detail.agents.firstOrNull()?.id
        val optimistic = _state.value.messages + ChatMessage("user", message, System.currentTimeMillis())
        _state.update { it.copy(messages = optimistic, message = "Deep Agent arbeitet …") }
        val reply = client.chat(detail.villa.id, rootId, message)
        val refreshed = client.villaDetail(detail.villa.id)
        val msgs = client.messages(detail.villa.id, rootId)
        _state.update {
            it.copy(
                detail = refreshed,
                messages = msgs,
                message = "Antwort über ${reply.route}${if (reply.offline) " (Offline-Planer)" else ""}"
            )
        }
    }

    fun orchestrate() = run {
        val detail = _state.value.detail ?: return@run
        client.orchestrate(detail.villa.id)
        _state.update { it.copy(message = "Entwicklung gestartet") }
        val refreshed = client.villaDetail(detail.villa.id)
        _state.update { it.copy(detail = refreshed) }
    }

    fun stop() = run {
        val detail = _state.value.detail ?: return@run
        client.stop(detail.villa.id)
        _state.update { it.copy(message = "Stopp angefordert") }
        val refreshed = client.villaDetail(detail.villa.id)
        _state.update { it.copy(detail = refreshed) }
    }

    /** Einzellne FAILED-Aufgabe zurueck in die Warteschlange und Lauf fortsetzen. */
    fun retryTask(taskId: Long) = run {
        val detail = _state.value.detail ?: return@run
        client.retryTask(detail.villa.id, taskId)
        _state.update { it.copy(message = "Aufgabe erneut gestartet") }
        val refreshed = client.villaDetail(detail.villa.id)
        _state.update { it.copy(detail = refreshed) }
    }

    /** Alle gescheiterten Aufgaben der Villa erneut starten. */
    fun retryFailed() = run {
        val detail = _state.value.detail ?: return@run
        val res = client.retryFailed(detail.villa.id)
        val n = res.optInt("requeued", 0)
        _state.update { it.copy(message = if (n > 0) "$n Aufgabe(n) erneut gestartet" else "Keine fehlgeschlagenen Aufgaben") }
        val refreshed = client.villaDetail(detail.villa.id)
        _state.update { it.copy(detail = refreshed) }
    }

    /** Loescht die offene Villa mitsamt allen Daten und kehrt zur Liste zurueck. */
    fun delete() = run {
        val detail = _state.value.detail ?: return@run
        client.deleteVilla(detail.villa.id)
        val villas = client.villas()
        _state.update { it.copy(detail = null, messages = emptyList(), villas = villas, message = "Villa gelöscht") }
    }

    /** Benennt die offene Villa um bzw. aktualisiert die Idee (PATCH). */
    fun editVilla(name: String, idea: String) = run {
        val detail = _state.value.detail ?: return@run
        client.patchVilla(detail.villa.id, name, idea)
        val refreshed = client.villaDetail(detail.villa.id)
        _state.update { it.copy(detail = refreshed, message = "Villa aktualisiert") }
    }

    /** Exportiert die offene Villa als JSON-Text (zum Teilen/Speichern). */
    fun export(onReady: (String) -> Unit) = run {
        val detail = _state.value.detail ?: return@run
        val json = client.exportVilla(detail.villa.id)
        onReady(json)
        _state.update { it.copy(message = "Export bereit") }
    }

    /** Aktualisiert den Stand waehrend eines laufenden Durchlaufs. */
    fun refreshDetail() = run {
        val detail = _state.value.detail ?: return@run
        val refreshed = client.villaDetail(detail.villa.id)
        val prod = fetchProduct(detail.villa.id)
        _state.update { it.copy(detail = refreshed, product = prod) }
    }

    /** Marktreife laden; Fehler sind unkritisch (Karte bleibt dann einfach weg). */
    private suspend fun fetchProduct(id: Long): org.json.JSONObject? =
        try { client.product(id) } catch (e: Exception) { null }

    fun toggleRoute(route: LlmRoute) = run {
        client.setRouteEnabled(route.id, !route.enabled)
        val routes = client.routes()
        _state.update { it.copy(routes = routes) }
    }

    fun saveSecret(name: String, value: String) = run {
        client.setSecret(name, value)
        _state.update { it.copy(message = "Key $name gespeichert") }
        val routes = client.routes()
        _state.update { it.copy(routes = routes) }
    }

    fun closeDetail() = _state.update { it.copy(detail = null, messages = emptyList(), product = null) }

    fun clearMessage() = _state.update { it.copy(message = "", error = null) }

    companion object {
        /** Maximal vorgehaltene Live-Ereignisse im Feed. */
        const val MAX_EVENTS = 100
    }
}
