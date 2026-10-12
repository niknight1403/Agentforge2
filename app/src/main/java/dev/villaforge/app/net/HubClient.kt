package dev.villaforge.app.net

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class Villa(
    val id: Long,
    val name: String,
    val idea: String,
    val status: String,
    val maxAgents: Int,
    val sourcePath: String = "",
    val mode: String = "BUILD"
)

data class Agent(
    val id: Long,
    val name: String,
    val role: String,
    val status: String,
    val isRoot: Boolean
)

data class Task(
    val id: Long,
    val title: String,
    val description: String,
    val status: String,
    val result: String
)

data class Memory(
    val id: Long,
    val title: String,
    val content: String,
    val kind: String,
    val importance: Int
)

data class ChatMessage(
    val role: String,
    val content: String,
    val createdAt: Long
)

data class Report(
    val id: Long,
    val kind: String,
    val title: String,
    val content: String,
    val createdAt: Long
)

data class VillaDetail(
    val villa: Villa,
    val agents: List<Agent>,
    val tasks: List<Task>,
    val memories: List<Memory>,
    val reports: List<Report>,
    val running: Boolean
)

data class ChatReply(
    val answer: String,
    val route: String,
    val model: String,
    val offline: Boolean
)

data class LlmRoute(
    val id: Long,
    val name: String,
    val provider: String,
    val model: String,
    val enabled: Boolean,
    val hasKey: Boolean,
    val priority: Int,
    val ok: Int,
    val fail: Int
)

/**
 * Duenner HTTP-Client gegen den VillaForge Hub. Die gesamte Agenten-, LLM- und
 * Werkzeuglogik liegt serverseitig; die App uebertraegt nur Ein-/Ausgaben.
 */
class HubClient(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("vf_settings", Context.MODE_PRIVATE)

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(180, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    var baseUrl: String
        get() {
            val saved = prefs.getString(KEY_BASE, DEFAULT_BASE) ?: DEFAULT_BASE
            // Migration: alte, tote Direkt-IPs (frueherer Hub) auf die stabile Adresse umziehen.
            if (LEGACY_HOSTS.any { saved.contains(it) }) {
                prefs.edit().putString(KEY_BASE, DEFAULT_BASE).apply()
                return DEFAULT_BASE
            }
            return saved
        }
        set(value) {
            val clean = value.trim().trimEnd('/')
            prefs.edit().putString(KEY_BASE, clean).apply()
        }

    /** Optionaler Bearer-Token, falls der Hub mit VF_TOKEN laeuft. */
    var apiToken: String
        get() = prefs.getString(KEY_TOKEN, "") ?: ""
        set(value) {
            val clean = value.trim()
            prefs.edit().putString(KEY_TOKEN, clean).apply()
        }

    /** Login-Zugangsdaten fuer das automatische Erneuern der Sitzung (nur privater App-Speicher). */
    var loginEmail: String
        get() = prefs.getString(KEY_EMAIL, "") ?: ""
        set(v) { prefs.edit().putString(KEY_EMAIL, v.trim()).apply() }
    private var loginPass: String
        get() = prefs.getString(KEY_PASS, "") ?: ""
        set(v) { prefs.edit().putString(KEY_PASS, v).apply() }
    val hasLogin: Boolean get() = loginEmail.isNotBlank() && loginPass.isNotBlank()

    /** Meldet am Hub an (POST /api/auth/login) und speichert den Sitzungs-Token. */
    suspend fun login(email: String, password: String): String = withContext(Dispatchers.IO) {
        val body = JSONObject().put("email", email.trim().lowercase()).put("password", password)
        val req = Request.Builder().url(url("/api/auth/login")).post(body.toString().toRequestBody(JSON)).build()
        http.newCall(req).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) throw HubException(res.code, text.take(200))
            val token = JSONObject(text).optString("token")
            if (token.isBlank()) throw HubException(500, "Kein Token erhalten")
            loginEmail = email
            loginPass = password
            apiToken = token
            token
        }
    }

    fun logout() {
        prefs.edit().remove(KEY_PASS).remove(KEY_TOKEN).apply()
    }

    val serverUrl: String get() = baseUrl

    private fun url(path: String) = "${baseUrl.trimEnd('/')}$path"

    private suspend fun execute(method: String, path: String, body: JSONObject? = null): String =
        try {
            executeOnce(method, path, body)
        } catch (e: HubException) {
            // Sitzung abgelaufen: mit gespeicherten Zugangsdaten still erneuern und einmal wiederholen.
            if (e.code == 401 && hasLogin && path != "/api/auth/login") {
                login(loginEmail, loginPass)
                executeOnce(method, path, body)
            } else throw e
        }

    private suspend fun executeOnce(method: String, path: String, body: JSONObject? = null): String =
        withContext(Dispatchers.IO) {
            val builder = Request.Builder().url(url(path))
            if (apiToken.isNotBlank()) builder.header("Authorization", "Bearer $apiToken")
            when (method) {
                "GET" -> builder.get()
                "POST" -> builder.post((body ?: JSONObject()).toString().toRequestBody(JSON))
                "PATCH" -> builder.patch((body ?: JSONObject()).toString().toRequestBody(JSON))
                else -> builder.method(method, null)
            }
            http.newCall(builder.build()).execute().use { res ->
                val text = res.body?.string().orEmpty()
                if (!res.isSuccessful) throw HubException(res.code, text.take(300))
                text
            }
        }

    suspend fun health(): JSONObject = JSONObject(execute("GET", "/api/health"))

    /** Hub-Statistik (GET /api/stats): Zaehler, Laufzeit, laufende Villen. */
    suspend fun stats(): JSONObject = JSONObject(execute("GET", "/api/stats"))

    suspend fun villas(): List<Villa> {
        val arr = JSONArray(execute("GET", "/api/villas"))
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            Villa(
                id = o.getLong("id"),
                name = o.getString("name"),
                idea = o.optString("idea"),
                status = o.optString("status"),
                maxAgents = o.optInt("max_agents", 1000)
            )
        }
    }

    suspend fun createVilla(name: String, idea: String, agentCount: Int, sourcePath: String = ""): Long {
        val body = JSONObject()
            .put("name", name)
            .put("idea", idea)
            .put("agentCount", agentCount)
        if (sourcePath.isNotBlank()) {
            body.put("sourcePath", sourcePath.trim())
            body.put("mode", "ANALYZE")
        }
        return JSONObject(execute("POST", "/api/villas", body)).getLong("villaId")
    }

    suspend fun analyze(villaId: Long) {
        execute("POST", "/api/villas/$villaId/analyze", JSONObject())
    }

    suspend fun setSource(villaId: Long, path: String) {
        execute("POST", "/api/villas/$villaId/source", JSONObject().put("path", path.trim()))
    }

    suspend fun villaDetail(id: Long): VillaDetail {
        val o = JSONObject(execute("GET", "/api/villas/$id"))
        val v = o.getJSONObject("villa")

        fun agents(): List<Agent> {
            val a = o.optJSONArray("agents") ?: JSONArray()
            return (0 until a.length()).map { i ->
                val x = a.getJSONObject(i)
                Agent(
                    id = x.getLong("id"),
                    name = x.optString("name"),
                    role = x.optString("role"),
                    status = x.optString("status"),
                    isRoot = x.optInt("is_root") == 1
                )
            }
        }

        fun tasks(): List<Task> {
            val a = o.optJSONArray("tasks") ?: JSONArray()
            return (0 until a.length()).map { i ->
                val x = a.getJSONObject(i)
                Task(
                    id = x.getLong("id"),
                    title = x.optString("title"),
                    description = x.optString("description"),
                    status = x.optString("status"),
                    result = x.optString("result")
                )
            }
        }

        fun memories(): List<Memory> {
            val a = o.optJSONArray("memories") ?: JSONArray()
            return (0 until a.length()).map { i ->
                val x = a.getJSONObject(i)
                Memory(
                    id = x.getLong("id"),
                    title = x.optString("title"),
                    content = x.optString("content"),
                    kind = x.optString("kind"),
                    importance = x.optInt("importance", 5)
                )
            }
        }

        fun reports(): List<Report> {
            val a = o.optJSONArray("reports") ?: JSONArray()
            return (0 until a.length()).map { i ->
                val x = a.getJSONObject(i)
                Report(
                    id = x.getLong("id"),
                    kind = x.optString("kind"),
                    title = x.optString("title"),
                    content = x.optString("content"),
                    createdAt = x.optLong("created_at")
                )
            }
        }

        return VillaDetail(
            villa = Villa(
                id = v.getLong("id"),
                name = v.getString("name"),
                idea = v.optString("idea"),
                status = v.optString("status"),
                maxAgents = v.optInt("max_agents", 1000),
                sourcePath = v.optString("source_path"),
                mode = v.optString("mode", "BUILD")
            ),
            agents = agents(),
            tasks = tasks(),
            memories = memories(),
            reports = reports(),
            running = o.optBoolean("running", false)
        )
    }

    suspend fun messages(villaId: Long, agentId: Long?): List<ChatMessage> {
        val path = if (agentId != null) "/api/villas/$villaId/messages?agentId=$agentId"
        else "/api/villas/$villaId/messages"
        val arr = JSONArray(execute("GET", path))
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            ChatMessage(
                role = o.optString("role"),
                content = o.optString("content"),
                createdAt = o.optLong("created_at")
            )
        }
    }

    suspend fun chat(villaId: Long, agentId: Long?, message: String): ChatReply {
        val body = JSONObject().put("message", message)
        if (agentId != null) body.put("agentId", agentId)
        val o = JSONObject(execute("POST", "/api/villas/$villaId/chat", body))
        return ChatReply(
            answer = o.optString("answer").ifBlank { o.optString("error") },
            route = o.optString("route"),
            model = o.optString("model"),
            offline = o.optBoolean("offline", false)
        )
    }

    suspend fun orchestrate(villaId: Long, concurrency: Int = 4, maxTasks: Int = 500) {
        val body = JSONObject().put("concurrency", concurrency).put("maxTasks", maxTasks)
        execute("POST", "/api/villas/$villaId/orchestrate", body)
    }

    suspend fun stop(villaId: Long) {
        execute("POST", "/api/villas/$villaId/stop", JSONObject())
    }

    /** Stellt eine gescheiterte Aufgabe zurueck in die Warteschlange (Sprint 54-Endpunkt). */
    suspend fun retryTask(villaId: Long, taskId: Long): JSONObject =
        JSONObject(execute("POST", "/api/villas/$villaId/tasks/$taskId/retry", JSONObject()))

    /** Requeued alle FAILED-Aufgaben der Villa auf einmal. */
    suspend fun retryFailed(villaId: Long): JSONObject =
        JSONObject(execute("POST", "/api/villas/$villaId/retry-failed", JSONObject()))

    suspend fun deleteVilla(villaId: Long) {
        execute("DELETE", "/api/villas/$villaId")
    }

    /** Aktualisiert Name und Idee einer Villa (PATCH /api/villas/:id). */
    suspend fun patchVilla(villaId: Long, name: String, idea: String) {
        execute("PATCH", "/api/villas/$villaId", JSONObject().put("name", name).put("idea", idea))
    }

    /** Kompletter JSON-Export der Villa (Villa, Agenten, Aufgaben, Berichte …). */
    suspend fun exportVilla(villaId: Long): String =
        execute("GET", "/api/villas/$villaId/export")

    suspend fun routes(): List<LlmRoute> {
        val arr = JSONArray(execute("GET", "/api/routes"))
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            LlmRoute(
                id = o.getLong("id"),
                name = o.optString("name"),
                provider = o.optString("provider"),
                model = o.optString("model"),
                enabled = o.optInt("enabled") == 1,
                hasKey = o.optBoolean("hasKey", false),
                priority = o.optInt("priority", 10),
                ok = o.optInt("ok", 0),
                fail = o.optInt("fail", 0)
            )
        }
    }

    suspend fun setRouteEnabled(id: Long, enabled: Boolean) {
        execute("PATCH", "/api/routes/$id", JSONObject().put("enabled", enabled))
    }

    suspend fun setSecret(name: String, value: String) {
        execute("POST", "/api/secrets", JSONObject().put("name", name).put("value", value))
    }

    /** Rat der Agenten: letzte Runden (GET /api/villas/:id/council). */
    suspend fun council(villaId: Long): org.json.JSONArray =
        org.json.JSONArray(execute("GET", "/api/villas/$villaId/council"))

    /** Beruft eine neue Rat-Runde ein (POST /api/villas/:id/council). */
    suspend fun councilTrigger(villaId: Long): org.json.JSONObject =
        org.json.JSONObject(execute("POST", "/api/villas/$villaId/council", JSONObject()))

    companion object {
        // Vorgabe: Hub auf dem Entwickler-Rechner, aus dem Android-Emulator
        // erreichbar (10.0.2.2 = Loopback des Hosts). Auf echten Geraeten wird
        // die Adresse in den App-Einstellungen auf die LAN-IP gesetzt.
        const val DEFAULT_BASE = "https://hub.cybersarah-ki.com"
        private val LEGACY_HOSTS = listOf("152.70.8.227", "10.0.2.2", "92.5.177.159")
        private const val KEY_EMAIL = "login_email"
        private const val KEY_PASS = "login_pass"
        private const val KEY_BASE = "base_url"
        private const val KEY_TOKEN = "api_token"
        private val JSON = "application/json; charset=utf-8".toMediaType()
    }
}

class HubException(val code: Int, val detail: String) :
    Exception("Hub antwortet mit HTTP $code: $detail")
