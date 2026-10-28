package dev.villaforge.app.net

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

data class Villa(
    val id: Long,
    val name: String,
    val idea: String,
    val status: String,
    val maxAgents: Int,
    val sourcePath: String = "",
    val mode: String = "BUILD",
    /** Live: haelt gerade einen Rechen-Slot (arbeitet wirklich). */
    val executing: Boolean = false,
    /** Live: Autonomie an, aber wartet auf einen freien Slot. */
    val queued: Boolean = false,
    /** Live: Titel der Aufgaben, die gerade laufen. */
    val runningTasks: List<String> = emptyList(),
    /** Live: offene Aufgaben. */
    val openCount: Int = 0,
    /** Live: geschaetzte Restdauer in Minuten (0 = nichts offen). */
    val etaMin: Int = 0,
    /** Estimate exceeds 24h, so the UI shows a bounded range. */
    val etaCapped: Boolean = false,
    /** WAS genau am Ende verkauft wird (aus dem Umsatz-Plan der Agenten). */
    val vision: String = ""
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

/** Deep-Agent: Ein eigenes App-Projekt (abseits der Villen). */
data class DeepProject(
    val id: Long,
    val title: String,
    val status: String,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val messages: Int = 0,
    val idea: String = "",
    val villaId: Long = 0)

/** Deep-Agent: Nachricht im Projekt-Chat. */
data class DeepMessage(
    val id: Long,
    val role: String,
    val content: String,
    val attachments: String = "",
    val createdAt: Long = 0
)

/** Deep-Agent: Anhang an eine Nachricht. */
data class DeepAttachment(
    val kind: String, // file | repo | link
    val fileId: Long = 0,
    val url: String = "",
    val name: String = ""
)

/** Eine optische Design-Stilrichtung des Master-Designers. */
data class DesignVariant(
    val label: String,
    val key: String,
    val url: String
)

data class ChatMessage(
    val role: String,
    val content: String,
    val createdAt: Long,
    val agentId: Long = 0,
    /** Master-Agent: erzeugte Villa (0 = keine). */
    val villaId: Long = 0,
    val villaName: String = "",
    /** Master-Agent: Design-Konzeptbild-URL (leer = keins). */
    val designImage: String = "",
    /** Master-Agent: optische Stilvarianten zur Auswahl (leer = keine). */
    val designVariants: List<DesignVariant> = emptyList()
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

    /** Offline-Cache: letzte bekannte Antworten des Hubs als JSON-Snapshots. */
    private val snapshotDir = File(context.applicationContext.cacheDir, "snapshots").apply { mkdirs() }

    private fun saveSnapshot(key: String, body: String) {
        runCatching { File(snapshotDir, key).writeText(body) }
    }

    private fun readSnapshot(key: String): String? =
        File(snapshotDir, key).takeIf { it.exists() }?.let { f -> runCatching { f.readText() }.getOrNull() }

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        // Harter Gesamt-Timeout je Aufruf: ein haengender DNS-/TLS-/Proxy-Schritt
        // darf die App nie endlos auf "verbinde ..." stehen lassen.
        .callTimeout(150, TimeUnit.SECONDS)
        // IPv4 zuerst: der Hub hat nur eine A-Adresse; ein toter IPv6-Pfad
        // (manche WLANs/Mobilfunk-Netze) wuerde sonst jeden Aufruf ausbremsen.
        .dns(object : okhttp3.Dns {
            override fun lookup(hostname: String): List<java.net.InetAddress> =
                okhttp3.Dns.SYSTEM.lookup(hostname).sortedBy { it is java.net.Inet6Address }
        })
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
    /** Liest die Design-Stilvarianten aus der Master-Antwort ([{label, key, url}]). */
    private fun parseDesignVariants(arr: org.json.JSONArray?): List<DesignVariant> {
        if (arr == null) return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val url = o.optString("url")
            if (url.isBlank()) null
            else DesignVariant(
                label = o.optString("label").ifBlank { "Design ${i + 1}" },
                key = o.optString("key"),
                url = url
            )
        }
    }

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
        } catch (e: java.io.IOException) {
            // Netzwerk-Kurzstoerung: einmal kurz warten und still neu versuchen.
            delay(800)
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

    /** Persistent Master-Agent history, oldest first. */
    suspend fun masterHistory(): List<ChatMessage> {
        val arr = JSONArray(execute("GET", "/api/master/messages"))
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            ChatMessage(role = o.optString("role", "assistant"), content = o.optString("content"),
                createdAt = o.optLong("created_at", o.optLong("createdAt")))
        }
    }
    suspend fun masterSuggestions(): JSONArray = JSONArray(execute("GET", "/api/master/suggestions"))
    suspend fun masterStatus(): JSONObject = JSONObject(execute("GET", "/api/master/status"))
    suspend fun masterAction(type: String, args: JSONObject, confirmation: String = ""): JSONObject =
        JSONObject(execute("POST", "/api/master/actions",
            JSONObject().put("action", JSONObject().put("type", type).put("args", args)).put("confirmation", confirmation)))
    suspend fun masterChat(message: String, requestId: String = java.util.UUID.randomUUID().toString()): JSONObject =
        JSONObject(execute("POST", "/api/master/chat", JSONObject().put("message", message).put("requestId", requestId)))
    suspend fun masterTurn(requestId: String): JSONObject = JSONObject(execute("GET", "/api/master/turn/$requestId"))
    suspend fun dismissMasterSuggestion(id: String) { execute("POST", "/api/master/suggestions/dismiss", JSONObject().put("id", id)) }

    /**
     * Verbindungstest fuer die Diagnose: DNS, TLS/HTTP-Health und Login einzeln mit
     * Dauer und GENAUER Fehlerursache (statt endlos "verbinde ...").
     */
    suspend fun connectionTest(): List<String> = withContext(Dispatchers.IO) {
        val out = mutableListOf<String>()
        val host = runCatching { java.net.URI(baseUrl).host }.getOrNull().orEmpty()
        var t = System.currentTimeMillis()
        try {
            val addrs = java.net.InetAddress.getAllByName(host).joinToString { it.hostAddress ?: "?" }
            out += "DNS OK (${System.currentTimeMillis() - t} ms): $addrs"
        } catch (e: Exception) { out += "DNS FEHLER: ${e.javaClass.simpleName}: ${e.message}" }
        t = System.currentTimeMillis()
        try {
            val res = http.newBuilder().callTimeout(20, TimeUnit.SECONDS).build()
                .newCall(Request.Builder().url(url("/api/health")).get().build()).execute()
            res.use { out += "Health HTTP ${it.code} (${System.currentTimeMillis() - t} ms, ${it.protocol})" }
        } catch (e: Exception) { out += "Health FEHLER nach ${System.currentTimeMillis() - t} ms: ${e.javaClass.simpleName}: ${e.message}" }
        t = System.currentTimeMillis()
        try {
            val res = http.newBuilder().callTimeout(30, TimeUnit.SECONDS).build()
                .newCall(Request.Builder().url(url("/api/villas")).apply {
                    if (apiToken.isNotBlank()) header("Authorization", "Bearer $apiToken")
                }.get().build()).execute()
            res.use { out += "Villen HTTP ${it.code} (${System.currentTimeMillis() - t} ms, ${(it.body?.contentLength() ?: -1)} Bytes)" }
        } catch (e: Exception) { out += "Villen FEHLER nach ${System.currentTimeMillis() - t} ms: ${e.javaClass.simpleName}: ${e.message}" }
        out += "Token: ${if (apiToken.isBlank()) "keiner" else "vorhanden"} · Login gespeichert: $hasLogin"
        out
    }

    /** Misst die Hub-Antwortzeit in Millisekunden (null = nicht erreichbar). */
    suspend fun ping(): Long? {
        val t0 = System.currentTimeMillis()
        return try {
            execute("GET", "/api/health")
            System.currentTimeMillis() - t0
        } catch (e: Exception) { null }
    }

    /** Hinterlegte Hub-Secrets (nur Name und Zeitstempel, nie Werte). */
    suspend fun secrets(): JSONArray = JSONArray(execute("GET", "/api/secrets"))

    /** Hub-Statistik (GET /api/stats): Zaehler, Laufzeit, laufende Villen. */
    suspend fun stats(): JSONObject = JSONObject(execute("GET", "/api/stats").also { saveSnapshot("stats.json", it) })

    /** Scheduler-Fokus, damit Villa-Liste und Startknöpfe den Hub-Zustand zeigen. */
    suspend fun schedulerStatus(): JSONObject = JSONObject(execute("GET", "/api/scheduler"))

    suspend fun villas(): List<Villa> =
        parseVillas(execute("GET", "/api/villas").also { saveSnapshot("villas.json", it) })

    /** Letzten bekannten Villenstand aus dem Offline-Cache (null falls keiner existiert). */
    fun villasFromCache(): List<Villa>? =
        readSnapshot("villas.json")?.let { raw -> runCatching { parseVillas(raw) }.getOrNull() }

    private fun parseVillas(raw: String): List<Villa> {
        val arr = JSONArray(raw)
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            Villa(
                id = o.getLong("id"),
                name = o.getString("name"),
                idea = o.optString("idea"),
                status = o.optString("status"),
                maxAgents = o.optInt("max_agents", 1000),
                executing = o.optInt("executing", 0) == 1,
                queued = o.optInt("queued", 0) == 1,
                runningTasks = run {
                    val a = o.optJSONArray("runningTasks") ?: JSONArray()
                    (0 until a.length()).map { i -> a.optString(i) }
                },
                openCount = o.optInt("openCount", 0),
                etaMin = o.optInt("etaMin", 0),
                etaCapped = o.optBoolean("etaCapped", false),
                vision = o.optString("vision")
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

    suspend fun villaDetail(id: Long): VillaDetail =
        parseVillaDetail(execute("GET", "/api/villas/$id").also { saveSnapshot("villa-$id.json", it) })

    /** Letzten bekannten Detailstand einer Villa aus dem Offline-Cache. */
    /** Groesse aller Offline-Snapshots in Bytes (fuer die Diagnose-Anzeige). */
    fun snapshotsSizeBytes(): Long =
        snapshotDir.listFiles()?.sumOf { if (it.isFile) it.length() else 0L } ?: 0L

    /** Loescht alle Offline-Snapshots. */
    fun clearSnapshots() {
        snapshotDir.listFiles()?.forEach { it.delete() }
    }

    fun villaDetailFromCache(id: Long): VillaDetail? =
        readSnapshot("villa-$id.json")?.let { raw -> runCatching { parseVillaDetail(raw) }.getOrNull() }

    /** Build-Status der Villa (GET /api/villas/:id/build). */
    suspend fun buildStatus(villaId: Long): JSONObject =
        JSONObject(execute("GET", "/api/villas/$villaId/build"))

    /** Startet den Produkt-Build (POST /api/villas/:id/build). */
    suspend fun startBuild(villaId: Long): JSONObject =
        JSONObject(execute("POST", "/api/villas/$villaId/build", JSONObject()))

    /** Live-Vorschau-Info (GET /api/villas/:id/preview). */
    suspend fun previewInfo(villaId: Long): JSONObject =
        JSONObject(execute("GET", "/api/villas/$villaId/preview"))

    /** WAS/WARUM/WIE-Erklaerung der aktuellen Villa-Aktivitaet (POST /api/villas/:id/explain). */
    suspend fun explain(villaId: Long): JSONObject =
        JSONObject(execute("POST", "/api/villas/$villaId/explain", JSONObject()))

    /** Offene Analyse-Vorschlaege des Innovations-Scouts (GET /api/proposals). */
    suspend fun proposals(): org.json.JSONArray =
        org.json.JSONArray(execute("GET", "/api/proposals"))

    /** Scout anstossen: nach einer besseren Alternative suchen (POST /api/proposals/scan). */
    suspend fun proposalsScan(): JSONObject =
        JSONObject(execute("POST", "/api/proposals/scan", JSONObject()))

    /** Vorschlag bestaetigen: Hub gruendet autonom eine Villa (POST /api/proposals/:id/approve). */
    suspend fun proposalApprove(id: Long): JSONObject =
        JSONObject(execute("POST", "/api/proposals/$id/approve", JSONObject()))

    /** Vorschlag ablehnen (POST /api/proposals/:id/reject). */
    suspend fun proposalReject(id: Long): JSONObject =
        JSONObject(execute("POST", "/api/proposals/$id/reject", JSONObject()))

    /** Autorisierungs-Header fuer externe Downloads (DownloadManager, WebView). */
    /* ---- Deep Agent: eigene App-Projekte (v1.37.0) ---- */

    /** Projekt-Verlauf (neueste zuerst). */
    suspend fun deepProjects(): List<DeepProject> = withContext(Dispatchers.IO) {
        val arr = JSONArray(execute("GET", "/api/deep/projects"))
        (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            DeepProject(
                id = o.optLong("id"),
                title = o.optString("title"),
                status = o.optString("status", "ACTIVE"),
                createdAt = o.optLong("created_at"),
                updatedAt = o.optLong("updated_at"),
                messages = o.optInt("messages", 0),
                villaId = o.optLong("villa_id", 0)
            )
        }
    }

    /** Neues Projekt anlegen - der Deep Agent liefert den initialen Bauplan. */
    suspend fun deepCreateProject(idea: String): JSONObject =
        JSONObject(execute("POST", "/api/deep/projects", JSONObject().put("idea", idea)))

    /** Übergibt das Projekt idempotent an die autonome Villa-/Build-Kette. */
    suspend fun deepDevelopProject(id: Long): JSONObject =
        JSONObject(execute("POST", "/api/deep/projects/$id/develop", JSONObject()))

    /** Löscht genau dieses Deep-Projekt samt Chat und Anhängen. */
    suspend fun deepDeleteProject(id: Long): JSONObject =
        JSONObject(execute("DELETE", "/api/deep/projects/$id"))

    /** Projekt-Detail: Projekt + Nachrichten. */
    suspend fun deepProjectDetail(id: Long): Pair<DeepProject, List<DeepMessage>> = withContext(Dispatchers.IO) {
        val d = JSONObject(execute("GET", "/api/deep/projects/$id"))
        val po = d.getJSONObject("project")
        val project = DeepProject(
            id = po.optLong("id"),
            title = po.optString("title"),
            status = po.optString("status", "ACTIVE"),
            createdAt = po.optLong("created_at"),
            updatedAt = po.optLong("updated_at"),
            idea = po.optString("idea"),
            villaId = po.optLong("villa_id", 0)
        )
        val arr = d.optJSONArray("messages") ?: JSONArray()
        val messages = (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            DeepMessage(
                id = o.optLong("id"),
                role = o.optString("role"),
                content = o.optString("content"),
                attachments = o.optString("attachments", ""),
                createdAt = o.optLong("created_at")
            )
        }
        project to messages
    }

    /** Nachricht im Projekt-Chat senden (Antwort des Deep Agent). */
    suspend fun deepChat(projectId: Long, message: String, attachments: List<DeepAttachment>): JSONObject {
        val body = JSONObject().put("message", message)
        val arr = JSONArray()
        attachments.forEach { a ->
            arr.put(JSONObject()
                .put("kind", a.kind)
                .put("fileId", a.fileId)
                .put("url", a.url)
                .put("name", a.name))
        }
        body.put("attachments", arr)
        return JSONObject(execute("POST", "/api/deep/projects/$projectId/chat", body))
    }

    /** Datei-Anhang hochladen (Base64), liefert Datei-Id + Abruf-URL. */
    suspend fun deepUploadFile(projectId: Long, name: String, mime: String, base64: String): JSONObject =
        JSONObject(execute("POST", "/api/deep/projects/$projectId/files",
            JSONObject().put("name", name).put("mime", mime).put("data", base64)))

    fun authHeaderValue(): String? =
        if (apiToken.isNotBlank()) "Bearer $apiToken" else null

    /** Marktreife- und Phasendaten der Villa (GET /api/villas/:id/product). */
    suspend fun product(villaId: Long): JSONObject =
        JSONObject(execute("GET", "/api/villas/$villaId/product"))

    private fun parseVillaDetail(raw: String): VillaDetail {
        val o = JSONObject(raw)
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

    /** Laedt eine URL mit Auth-Header und liefert sie als WebView-Ressource (Live-Ansicht).
     *  Behebt weisse Seite: Skripte/CSS laden sonst ohne Auth (401). */
    fun webResource(url: String): android.webkit.WebResourceResponse? = try {
        val req = okhttp3.Request.Builder().url(url)
            .header("Authorization", authHeaderValue() ?: "")
            .build()
        val resp = http.newCall(req).execute()
        val mime = resp.header("Content-Type")?.substringBefore(';')?.trim() ?: "text/plain"
        val stream = resp.body?.byteStream()
        if (resp.isSuccessful && stream != null) android.webkit.WebResourceResponse(mime, "utf-8", stream)
        else { resp.close(); null }
    } catch (e: Exception) { null }


    suspend fun messages(villaId: Long, agentId: Long?): List<ChatMessage> {
        val path = if (agentId != null) "/api/villas/$villaId/messages?agentId=$agentId"
        else "/api/villas/$villaId/messages"
        val arr = JSONArray(execute("GET", path))
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            ChatMessage(
                role = o.optString("role"),
                content = o.optString("content"),
                createdAt = o.optLong("created_at"),
                agentId = o.optLong("agent_id")
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

    /** Uebernimmt die Ratsvorschlaege einer Runde als Aufgaben (POST council/adopt). */
    suspend fun councilAdopt(villaId: Long, roundId: Long = 0L): org.json.JSONObject =
        org.json.JSONObject(execute("POST", "/api/villas/$villaId/council/adopt", JSONObject().put("round", roundId)))

    /* ---- Villa-Evolution: jede Villa schlaegt selbst naechste Phasen, Perfektion und Marketplace vor ---- */

    /** Evolutions-Status einer Villa inkl. offener Vorschlaege (GET /api/evolution/villas/:id). */
    suspend fun evolution(villaId: Long): org.json.JSONObject =
        org.json.JSONObject(execute("GET", "/api/evolution/villas/$villaId"))

    /** Villa laesst sich einen Vorschlag der Art erzeugen: NEXT_PHASES | PERFECT | MARKETPLACE. */
    suspend fun evolutionPropose(villaId: Long, kind: String): org.json.JSONObject =
        org.json.JSONObject(execute("POST", "/api/evolution/villas/$villaId/propose", JSONObject().put("kind", kind)))

    /** Vorschlag bestaetigen: wird zu echten Aufgaben und die Villa entwickelt weiter. */
    suspend fun evolutionApprove(proposalId: Long): org.json.JSONObject =
        org.json.JSONObject(execute("POST", "/api/evolution/proposals/$proposalId/approve", JSONObject()))

    /** Vorschlag ablehnen. */
    suspend fun evolutionReject(proposalId: Long): org.json.JSONObject =
        org.json.JSONObject(execute("POST", "/api/evolution/proposals/$proposalId/reject", JSONObject()))

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
