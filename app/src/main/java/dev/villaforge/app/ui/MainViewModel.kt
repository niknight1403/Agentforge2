package dev.villaforge.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.villaforge.app.net.ChatMessage
import dev.villaforge.app.net.HubClient
import dev.villaforge.app.net.LlmRoute
import dev.villaforge.app.net.Villa
import dev.villaforge.app.net.VillaDetail
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class UiState(
    val serverUrl: String = HubClient.DEFAULT_BASE,
    val online: Boolean = false,
    val healthText: String = "verbinde …",
    val villas: List<Villa> = emptyList(),
    val detail: VillaDetail? = null,
    val messages: List<ChatMessage> = emptyList(),
    val routes: List<LlmRoute> = emptyList(),
    val busy: Boolean = false,
    val message: String = "",
    val error: String? = null
)

class MainViewModel(app: Application) : AndroidViewModel(app) {

    private val client = HubClient(app)
    private val _state = MutableStateFlow(UiState(serverUrl = client.serverUrl))
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        refreshAll()
    }

    private fun run(block: suspend () -> Unit) {
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null) }
            try {
                block()
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
        _state.update {
            it.copy(
                online = true,
                healthText = "Hub online · ${health.optInt("routes")} Routen · v${health.optString("version")}",
                villas = villas,
                routes = routes
            )
        }
    }

    fun saveServerUrl(url: String) {
        client.baseUrl = url
        _state.update { it.copy(serverUrl = client.serverUrl) }
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
        _state.update { it.copy(detail = detail, messages = msgs) }
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

    /** Aktualisiert den Stand waehrend eines laufenden Durchlaufs. */
    fun refreshDetail() = run {
        val detail = _state.value.detail ?: return@run
        val refreshed = client.villaDetail(detail.villa.id)
        _state.update { it.copy(detail = refreshed) }
    }

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

    fun closeDetail() = _state.update { it.copy(detail = null, messages = emptyList()) }

    fun clearMessage() = _state.update { it.copy(message = "", error = null) }
}
