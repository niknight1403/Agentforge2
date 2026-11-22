package dev.villaforge.app.ui.screens

import android.content.Context
import android.speech.tts.TextToSpeech
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.VideoLibrary
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material.icons.filled.StopCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.viewinterop.AndroidView
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import java.net.HttpURLConnection
import java.net.URL
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.villaforge.app.ui.MainViewModel
import dev.villaforge.app.ui.UiState
import dev.villaforge.app.ui.components.GlassCard
import dev.villaforge.app.ui.components.NeonChip
import dev.villaforge.app.ui.theme.ElectricBlue
import dev.villaforge.app.ui.theme.NeonCyan
import dev.villaforge.app.ui.theme.NeonPink
import dev.villaforge.app.ui.theme.TextMain
import dev.villaforge.app.ui.theme.TextMuted
import dev.villaforge.app.ui.theme.Ink
import dev.villaforge.app.ui.theme.Surface1
import dev.villaforge.app.ui.theme.Border
import dev.villaforge.app.ui.theme.Warn
import dev.villaforge.app.ui.theme.Success
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.delay

/*
 * DEEP AGENT (v1.37.0): Eigener Entwicklungs-Bereich ABSEITS der Villen.
 * - DeepAgentScreen: Projekt-Verlauf + "Neues Projekt" (App-Idee)
 * - DeepChatScreen: 1:1-Entwicklungs-Chat je Projekt mit "+"
 *   fuer Anhaenge (Foto, Video, Datei, GitHub-Repo, Link).
 * Jeder neue Deep Agent oeffnet ein neues Projekt; die vorherigen
 * Projekte bleiben im Verlauf (mit Gedaechtnis im Hub).
 */

private val fmt = SimpleDateFormat("dd.MM. HH:mm", Locale.getDefault())

@Composable
fun DeepAgentScreen(state: UiState, viewModel: MainViewModel, onOpenProject: (Long) -> Unit, onBack: () -> Unit) {
    LaunchedEffect(Unit) { viewModel.loadDeepProjects() }
    var idea by remember { mutableStateOf("") }
    var showNew by remember { mutableStateOf(false) }
    var deleteProject by remember { mutableStateOf<dev.villaforge.app.net.DeepProject?>(null) }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, "zurueck", tint = TextMain) }
            Column(Modifier.weight(1f)) {
                Text("Deep Agent", fontWeight = FontWeight.ExtraBold, fontSize = 20.sp, color = TextMain)
                Text("Eigene App-Ideen umsetzen - abseits der Villen", style = MaterialTheme.typography.labelSmall, color = TextMuted)
            }
            IconButton(onClick = { showNew = !showNew }) {
                Icon(Icons.Filled.Add, "neues Projekt", tint = NeonCyan)
            }
        }
        Spacer(Modifier.height(8.dp))

        if (showNew || state.deepProjects.isEmpty()) {
            GlassCard(accent = NeonCyan, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.fillMaxWidth().padding(14.dp)) {
                    Text("NEUES PROJEKT", style = MaterialTheme.typography.labelSmall, color = TextMuted, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(6.dp))
                    OutlinedTextField(
                        value = idea,
                        onValueChange = { idea = it },
                        placeholder = { Text("Beschreibe deine App-Idee ...") },
                        modifier = Modifier.fillMaxWidth(),
                        minLines = 2
                    )
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                        TextButton(
                            onClick = {
                                if (idea.isNotBlank()) {
                                    viewModel.createDeepProject(idea) { onOpenProject(it) }
                                    idea = ""
                                    showNew = false
                                }
                            },
                            enabled = idea.isNotBlank() && !state.busy
                        ) { Text(if (state.busy) "Deep Agent startet ..." else "Projekt starten") }
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
        }

        if (state.deepProjects.isEmpty() && !showNew) {
            Box(Modifier.fillMaxWidth().padding(top = 32.dp), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Filled.Folder, null, tint = TextMuted, modifier = Modifier.size(42.dp))
                    Spacer(Modifier.height(8.dp))
                    Text("Noch keine Projekte", color = TextMuted)
                }
            }
        }

        LazyColumn(state = rememberLazyListState(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.deepProjects) { prj ->
                GlassCard(accent = ElectricBlue, modifier = Modifier.fillMaxWidth()) {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(12.dp)) {
                        Column(Modifier.weight(1f).clickable { onOpenProject(prj.id) }) {
                            Text(prj.title, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = TextMain, maxLines = 1)
                            Text(
                                "${prj.messages} Nachrichten · ${if (prj.villaId > 0) "Villa #${prj.villaId}" else fmt.format(Date(prj.updatedAt))}",
                                style = MaterialTheme.typography.labelSmall, color = TextMuted
                            )
                        }
                        NeonChip(prj.status, NeonCyan)
                        IconButton(onClick = { deleteProject = prj }) {
                            Icon(Icons.Filled.Delete, "Projekt löschen", tint = TextMuted)
                        }
                    }
                }
            }
        }
        deleteProject?.let { target ->
            AlertDialog(
                onDismissRequest = { deleteProject = null },
                title = { Text("Deep-Projekt löschen?") },
                text = { Text("\"${target.title}\" samt Chatverlauf und hochgeladenen Dateien endgültig löschen. Eine bereits übergebene Villa bleibt als separates Entwicklungsprojekt erhalten.") },
                confirmButton = {
                    TextButton(onClick = { viewModel.deleteDeepProject(target.id); deleteProject = null }) { Text("Endgültig löschen") }
                },
                dismissButton = { TextButton(onClick = { deleteProject = null }) { Text("Abbrechen") } }
            )
        }
    }
}

@Composable
fun DeepChatScreen(state: UiState, viewModel: MainViewModel, onBack: () -> Unit, onOpenVilla: (Long) -> Unit) {
    val project = state.deepActiveProject
    if (project == null) {
        // Navigation is immediate, but project detail is loaded asynchronously.
        // Never navigate from composition: that caused a back-navigation flash.
        Column(
            modifier = Modifier.fillMaxSize().padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            if (state.deepOpenError != null) {
                Text("Projekt konnte nicht geladen werden", color = TextMain, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(8.dp))
                Text(state.deepOpenError, color = TextMuted)
                state.deepOpeningProjectId?.let { id ->
                    TextButton(onClick = { viewModel.openDeepProject(id) }) { Text("Erneut versuchen") }
                }
            } else if (state.deepOpeningProjectId != null) {
                CircularProgressIndicator(color = NeonCyan)
                Spacer(Modifier.height(12.dp))
                Text("Projekt wird geladen …", color = TextMuted)
            } else {
                Text("Kein Projekt geöffnet", color = TextMuted)
            }
            TextButton(onClick = onBack) { Text("Zurück zur Projektliste") }
        }
        return
    }
    var input by rememberSaveable(project.id) { mutableStateOf("") }
    var composerFocused by remember { mutableStateOf(false) }
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    var showAttachMenu by remember { mutableStateOf(false) }
    var showRepoDialog by remember { mutableStateOf(false) }
    var showPreview by rememberSaveable(project.id) { mutableStateOf(false) }
    var showWorkspaceDetails by rememberSaveable(project.id) { mutableStateOf(false) }
    var repoUrl by rememberSaveable(project.id) { mutableStateOf("") }
    val listState = rememberLazyListState()
    val context = LocalContext.current
    var ttsReady by remember { mutableStateOf(false) }
    val speechEngine = remember(context) {
        TextToSpeech(context) { status -> ttsReady = status == TextToSpeech.SUCCESS }
    }
    DisposableEffect(speechEngine) {
        onDispose { speechEngine.stop(); speechEngine.shutdown() }
    }
    val projectId = project.id

    /* Nativer Android-Picker: Fotos/Videos und beliebige Dateien */
    val mediaPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) viewModel.addDeepAttachmentFromUri(context, projectId, uri)
    }
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) viewModel.addDeepAttachmentFromUri(context, projectId, uri)
    }

    LaunchedEffect(state.deepMessages.size, showPreview) {
        if (!showPreview && state.deepMessages.isNotEmpty()) listState.animateScrollToItem(state.deepMessages.size - 1)
    }
    LaunchedEffect(projectId) {
        while (true) {
            viewModel.refreshDeepWorkspace(projectId)
            viewModel.refreshDeepMessages(projectId)
            delay(5_000)
        }
    }

    val workspace = state.deepWorkspace
    val completion = workspace?.optJSONObject("completion")
    val runtimeTools = workspace?.optJSONArray("capabilities") ?: org.json.JSONArray()
    val capabilityNote = workspace?.optString("capabilityNote").orEmpty()
    val availableTools = (0 until runtimeTools.length()).count { runtimeTools.optJSONObject(it)?.optString("status") == "available" }
    val livePreview = completion?.optJSONObject("live")
    val entry = livePreview?.optString("entry").orEmpty()
    val previewUrl = if (entry.isNotBlank()) viewModel.deepPreviewUrl(projectId, entry) else ""
    val previewReloadKey = "$previewUrl|${livePreview?.optString("revision").orEmpty()}"
    val projectEvents = if (project.villaId > 0) state.events.filter { it.villaId == project.villaId }.take(5) else emptyList()
    val keyboardOpen = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    val compactChat = LocalConfiguration.current.screenHeightDp < 700

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 8.dp).imePadding()) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, "Zurück zu Projekten", tint = TextMain) }
            Column(Modifier.weight(1f)) {
                Text(project.title, fontWeight = FontWeight.Bold, fontSize = 20.sp, color = TextMain, maxLines = 1)
                Text("DeepAgent · ${project.status}", style = MaterialTheme.typography.bodySmall, color = TextMuted)
            }
            if (state.busy) CircularProgressIndicator(Modifier.size(20.dp), color = NeonCyan)
        }
        Spacer(Modifier.height(12.dp))
        Row(
            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp))
                .background(Surface1).border(1.dp, Border, RoundedCornerShape(16.dp)).padding(4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            listOf("Chat", "Vorschau").forEachIndexed { index, label ->
                val selected = showPreview == (index == 1)
                TextButton(
                    onClick = { showPreview = index == 1; if (index == 0) showWorkspaceDetails = false },
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp)
                        .semantics { this.selected = selected }
                        .clip(RoundedCornerShape(12.dp))
                        .background(if (selected) NeonCyan else Surface1)
                ) {
                    Text(label, color = if (selected) Ink else TextMain, fontWeight = FontWeight.Bold)
                }
            }
        }
        Spacer(Modifier.height(12.dp))

        if (showPreview || (!keyboardOpen && !composerFocused && !compactChat)) {
        Column(
            modifier = Modifier.fillMaxWidth()
                .then(if (showPreview || showWorkspaceDetails) Modifier.weight(1f).verticalScroll(rememberScrollState()) else Modifier)
                .clip(RoundedCornerShape(16.dp))
                .background(Surface1).border(1.dp, Border, RoundedCornerShape(16.dp)).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Text(
                if (completion?.optBoolean("liveViewAvailable") == true && entry.isNotBlank()) "Live-Vorschau · Webansicht verfügbar"
                else "Live-Vorschau · noch nicht verfügbar",
                style = MaterialTheme.typography.titleMedium, color = TextMain
            )
            if (completion?.optBoolean("liveViewAvailable") == true && entry.isNotBlank() && !keyboardOpen && !composerFocused) {
                    AndroidView(
                        modifier = Modifier.fillMaxWidth().height(if (showPreview) 360.dp else 170.dp)
                            .clip(RoundedCornerShape(12.dp)),
                        factory = { ctx ->
                            WebView(ctx).apply {
                                settings.javaScriptEnabled = true
                                settings.domStorageEnabled = true
                                settings.allowFileAccess = false
                                settings.allowContentAccess = false
                                webViewClient = object : WebViewClient() {
                                    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                                        val target = request?.url?.toString() ?: return null
                                        return try {
                                            val targetUrl = URL(target)
                                            val hubOrigin = URL(state.serverUrl)
                                            val sameOrigin = targetUrl.protocol.equals(hubOrigin.protocol, ignoreCase = true) &&
                                                targetUrl.host.equals(hubOrigin.host, ignoreCase = true) &&
                                                (if (targetUrl.port >= 0) targetUrl.port else targetUrl.defaultPort) ==
                                                (if (hubOrigin.port >= 0) hubOrigin.port else hubOrigin.defaultPort)
                                            // Project HTML/JavaScript is untrusted. Never lend it the user's
                                            // Hub bearer for arbitrary same-origin API requests: credentials
                                            // are attached only to this project's confined preview subtree.
                                            val previewPathPrefix = URL(previewUrl)
                                                .path.substringBefore("/preview/") + "/preview/"
                                            if (!sameOrigin || !targetUrl.path.startsWith(previewPathPrefix)) return null
                                            val connection = targetUrl.openConnection() as HttpURLConnection
                                            connection.instanceFollowRedirects = false
                                            connection.connectTimeout = 8000
                                            connection.readTimeout = 15000
                                            viewModel.authHeader()?.let { connection.setRequestProperty("Authorization", it) }
                                            connection.connect()
                                            val contentType = connection.contentType.orEmpty()
                                            val mime = contentType.substringBefore(';').ifBlank { "application/octet-stream" }
                                            val charsetName = Regex("(?i)charset\\s*=\\s*[\"']?([^;\"'\\s]+)")
                                                .find(contentType)?.groupValues?.get(1)
                                            val charset = charsetName?.takeIf {
                                                runCatching { java.nio.charset.Charset.forName(it) }.isSuccess
                                            } ?: "UTF-8"
                                            val statusCode = connection.responseCode.takeIf { it in 100..599 } ?: 200
                                            val reasonPhrase = connection.responseMessage?.takeIf { it.isNotBlank() }
                                                ?: if (statusCode in 200..299) "OK" else "HTTP $statusCode"
                                            val responseHeaders = connection.headerFields
                                                .mapNotNull { (key, values) -> key?.let { it to values.joinToString(", ") } }
                                                .toMap()
                                            val responseBody = if (statusCode >= 400) {
                                                connection.errorStream ?: connection.inputStream
                                            } else connection.inputStream
                                            WebResourceResponse(mime, charset, statusCode, reasonPhrase, responseHeaders, responseBody)
                                        } catch (_: Exception) { null }
                                    }
                                }
                                // Credentials are restricted to this project's preview path and exact Hub origin.
                                tag = previewReloadKey
                                loadUrl(previewUrl)
                            }
                        },
                        update = { webView ->
                            if (webView.tag != previewReloadKey) {
                                webView.tag = previewReloadKey
                                webView.loadUrl(previewUrl)
                            }
                        }
                    )
            } else if (entry.isBlank() || completion?.optBoolean("liveViewAvailable") != true) {
                Text(
                    "Eine Vorschau erscheint, sobald für dieses Projekt ein echter Web-Build vorliegt.",
                    style = MaterialTheme.typography.bodyMedium, color = TextMuted
                )
            }
            val blockers = completion?.optJSONArray("blockers")?.length() ?: 0
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text(
                    when {
                        workspace?.has("error") == true -> "Abnahme: Status nicht erreichbar"
                        completion?.optBoolean("ready") == true -> "Abnahme: bereit"
                        completion == null -> "Abnahme: noch nicht geprüft"
                        blockers > 0 -> "Abnahme: $blockers Prüfungen offen"
                        else -> "Abnahme: offen · Nachweis fehlt"
                    },
                    modifier = Modifier.weight(1f),
                    color = if (completion?.optBoolean("ready") == true) Success else Warn,
                    style = MaterialTheme.typography.bodyMedium
                )
                if (project.villaId > 0) {
                    TextButton(onClick = { onOpenVilla(project.villaId) }) {
                        Text("Build & Downloads", color = NeonCyan)
                    }
                }
            }
            completion?.optJSONArray("nextActions")?.takeIf { it.length() > 0 }?.let { actions ->
                Text("Nächster Schritt: ${actions.optString(0)}", color = TextMuted,
                    style = MaterialTheme.typography.bodySmall, maxLines = 2)
            }
            TextButton(onClick = { showWorkspaceDetails = !showWorkspaceDetails },
                modifier = Modifier.heightIn(min = 44.dp)) {
                Text(if (showWorkspaceDetails) "Statusdetails schließen" else "Statusdetails und Werkzeuge anzeigen")
            }
            if (showWorkspaceDetails) {
                TextButton(onClick = { viewModel.developDeepProject(projectId) }, enabled = !state.busy,
                    modifier = Modifier.heightIn(min = 44.dp)) {
                    Text(if (project.villaId > 0) "Entwicklung fortsetzen" else "Autonom umsetzen")
                }
                Column(Modifier.heightIn(max = 180.dp).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Villa: ${if (project.villaId > 0) "#${project.villaId}" else "noch offen"} · " +
                        "Admin-Werkzeuge: $availableTools / ${runtimeTools.length()}",
                        style = MaterialTheme.typography.bodySmall, color = TextMuted)
                    if (workspace?.optBoolean("capabilitiesRestricted") == true) {
                        Text("Admin-Werkzeuge sind nur mit Administratorrechten sichtbar.",
                            style = MaterialTheme.typography.bodySmall, color = TextMuted)
                    }
                    if (capabilityNote.isNotBlank()) Text(capabilityNote,
                        style = MaterialTheme.typography.bodySmall, color = TextMuted)
                    (0 until runtimeTools.length()).forEach { index ->
                        runtimeTools.optJSONObject(index)?.let { tool ->
                            Text("${tool.optString("id")} · ${tool.optString("family")} · ${tool.optString("status")}",
                                style = MaterialTheme.typography.bodySmall, color = TextMuted)
                        }
                    }
                    workspace?.optString("error")?.takeIf { it.isNotBlank() }?.let {
                        Text("Live-Status: $it", style = MaterialTheme.typography.bodySmall, color = Warn)
                    }
                    if (projectEvents.isEmpty()) {
                        Text("Noch keine Agentenereignisse.", style = MaterialTheme.typography.bodySmall, color = TextMuted)
                    } else projectEvents.forEach { event ->
                        Text("${event.type}: ${event.text}", style = MaterialTheme.typography.bodySmall,
                            color = TextMain, maxLines = 2)
                    }
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        }
        if (!showPreview) {
            LazyColumn(state = listState, modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (state.deepMessages.isEmpty()) item {
                    Text("Schreibe dem DeepAgent, was als Nächstes entstehen soll.",
                        style = MaterialTheme.typography.bodyMedium, color = TextMuted,
                        modifier = Modifier.padding(vertical = 16.dp))
                }
                items(state.deepMessages) { msg ->
                    val mine = msg.role == "user"
                    Row(
                        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Box(
                            Modifier
                                .fillMaxWidth(if (mine) 0.86f else 0.92f)
                                .clip(RoundedCornerShape(12.dp))
                                .background(if (mine) NeonCyan.copy(alpha = 0.10f) else TextMuted.copy(alpha = 0.07f))
                                .padding(10.dp)
                        ) {
                            Column {
                                Text(msg.content, style = MaterialTheme.typography.bodyMedium, color = TextMain)
                                Text(
                                    fmt.format(Date(msg.createdAt)),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = TextMuted,
                                    fontSize = 12.sp
                                )
                                if (!mine) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        IconButton(
                                            onClick = {
                                                val languageStatus = speechEngine.setLanguage(Locale.GERMAN)
                                                if (ttsReady && languageStatus >= TextToSpeech.LANG_AVAILABLE) {
                                                    speechEngine.speak(msg.content.take(12000), TextToSpeech.QUEUE_FLUSH, android.os.Bundle(), "deep-chat-${msg.createdAt}")
                                                }
                                            },
                                            enabled = ttsReady
                                        ) {
                                            Icon(Icons.Filled.VolumeUp, contentDescription = "Antwort vorlesen", tint = if (ttsReady) NeonCyan else TextMuted)
                                        }
                                        IconButton(onClick = { speechEngine.stop() }, enabled = ttsReady) {
                                            Icon(Icons.Filled.StopCircle, contentDescription = "Sprachausgabe stoppen", tint = TextMuted)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if (state.deepPendingAttachments.isNotEmpty()) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(vertical = 4.dp)) {
                    state.deepPendingAttachments.forEach { a ->
                        NeonChip(
                            "📎 " + a.name.ifBlank { a.url },
                            NeonPink,
                            Modifier.clickable { viewModel.removeDeepAttachment(a.name, a.url) }
                        )
                    }
                }
            }

            if (showAttachMenu) {
                GlassCard(accent = NeonPink, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(8.dp)) {
                        Text("ANHANG HINZUFUEGEN", style = MaterialTheme.typography.labelSmall, color = TextMuted, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(4.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            AttachOption(Icons.Filled.Image, "Foto/Video") {
                                showAttachMenu = false
                                mediaPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                            }
                            AttachOption(Icons.Filled.Description, "Datei") {
                                showAttachMenu = false
                                filePicker.launch(arrayOf("*/*"))
                            }
                            AttachOption(Icons.Filled.Link, "GitHub-Repo") { showAttachMenu = false; showRepoDialog = true }
                        }
                        Text(
                            "Foto/Video und Dateien werden direkt hochgeladen (max. 12 MB). GitHub-Repo: URL angeben.",
                            style = MaterialTheme.typography.bodySmall, color = TextMuted
                        )
                    }
                }
                Spacer(Modifier.height(6.dp))
            }

            if (showRepoDialog) {
                GlassCard(accent = ElectricBlue, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(10.dp)) {
                        Text("GITHUB-REPOSITORY", style = MaterialTheme.typography.labelSmall, color = TextMuted, fontWeight = FontWeight.Bold)
                        OutlinedTextField(
                            value = repoUrl,
                            onValueChange = { repoUrl = it },
                            placeholder = { Text("https://github.com/user/projekt") },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true
                        )
                        Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                            TextButton(onClick = { showRepoDialog = false }) { Text("Abbrechen") }
                            TextButton(
                                onClick = {
                                    viewModel.addDeepLink("repo", repoUrl)
                                    showRepoDialog = false
                                    repoUrl = ""
                                },
                                enabled = repoUrl.isNotBlank()
                            ) { Text("Hinzufuegen") }
                        }
                    }
                }
                Spacer(Modifier.height(6.dp))
            }

            Row(verticalAlignment = Alignment.Bottom) {
                IconButton(onClick = { showAttachMenu = !showAttachMenu }) {
                    Icon(Icons.Filled.Add, "Anhang", tint = if (showAttachMenu) NeonCyan else TextMuted)
                }
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    placeholder = { Text("Nachricht an DeepAgent") },
                    modifier = Modifier.weight(1f).onFocusChanged { composerFocused = it.isFocused },
                    maxLines = 4
                )
                IconButton(
                    onClick = {
                        if (input.isNotBlank()) {
                            viewModel.sendDeep(input)
                            input = ""
                            focusManager.clearFocus()
                            keyboardController?.hide()
                        }
                    },
                    enabled = input.isNotBlank() && !state.busy
                ) { Icon(Icons.Filled.Send, "Nachricht senden", tint = NeonCyan) }
            }
        }
    }
}

@Composable
private fun AttachOption(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .clip(RoundedCornerShape(10.dp))
            .clickable { onClick() }
            .padding(8.dp)
    ) {
        Icon(icon, null, tint = NeonCyan, modifier = Modifier.size(22.dp))
        Text(label, style = MaterialTheme.typography.bodySmall, color = TextMain)
    }
}
