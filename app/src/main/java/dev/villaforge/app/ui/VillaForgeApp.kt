package dev.villaforge.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.villaforge.app.net.Agent
import dev.villaforge.app.net.ChatMessage
import dev.villaforge.app.net.LlmRoute
import dev.villaforge.app.net.Memory
import dev.villaforge.app.net.Report
import dev.villaforge.app.net.Task
import dev.villaforge.app.net.VillaEvent
import dev.villaforge.app.ui.theme.Aqua
import dev.villaforge.app.ui.theme.Danger
import dev.villaforge.app.ui.theme.Ink
import dev.villaforge.app.ui.theme.Surface1
import dev.villaforge.app.ui.theme.Surface2
import dev.villaforge.app.ui.theme.TextMain
import dev.villaforge.app.ui.theme.TextMuted
import dev.villaforge.app.ui.theme.Violet
import dev.villaforge.app.ui.theme.Warn
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private enum class Screen { LIST, CREATE, DETAIL, CHAT, SETTINGS }

@Composable
private fun muted() = MaterialTheme.typography.bodySmall

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VillaForgeApp(viewModel: MainViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var screen by remember { mutableStateOf(Screen.LIST) }

    Scaffold(
        containerColor = Ink,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("VillaForge", fontWeight = FontWeight.Bold)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(state.healthText, style = muted(), color = TextMuted)
                            Spacer(Modifier.width(6.dp))
                            LiveDot(state.live)
                        }
                    }
                },
                navigationIcon = {
                    if (screen != Screen.LIST) {
                        IconButton(onClick = {
                            when (screen) {
                                Screen.CHAT -> screen = Screen.DETAIL
                                else -> { screen = Screen.LIST; viewModel.closeDetail() }
                            }
                        }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Zurück") }
                    }
                },
                actions = {
                    if (screen == Screen.LIST) {
                        IconButton(onClick = { viewModel.refreshAll() }) {
                            Icon(Icons.Filled.Refresh, contentDescription = "Aktualisieren")
                        }
                        IconButton(onClick = { screen = Screen.SETTINGS }) {
                            Icon(Icons.Filled.Settings, contentDescription = "Einstellungen")
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Surface1,
                    titleContentColor = TextMain,
                    navigationIconContentColor = dev.villaforge.app.ui.theme.TextMain,
                    actionIconContentColor = dev.villaforge.app.ui.theme.TextMain
                )
            )
        },
        floatingActionButton = {
            if (screen == Screen.LIST) {
                Button(onClick = { screen = Screen.CREATE }, shape = RoundedCornerShape(16.dp)) {
                    Icon(Icons.Filled.Add, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("Deep Agent")
                }
            }
        }
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (screen) {
                Screen.LIST -> VillaListScreen(state) { id ->
                    viewModel.openVilla(id)
                    screen = Screen.DETAIL
                }
                Screen.CREATE -> CreateVillaScreen(state, viewModel) { id ->
                    viewModel.openVilla(id)
                    screen = Screen.CHAT
                }
                Screen.DETAIL -> DetailScreen(state, viewModel, onChat = { screen = Screen.CHAT })
                Screen.CHAT -> ChatScreen(state, viewModel)
                Screen.SETTINGS -> SettingsScreen(state, viewModel)
            }

            if (state.busy) {
                CircularProgressIndicator(
                    modifier = Modifier.align(Alignment.TopCenter).padding(top = 8.dp),
                    color = Aqua
                )
            }
        }
    }
}

/* ----------------------------- Liste ----------------------------- */

@Composable
private fun VillaListScreen(state: UiState, onOpen: (Long) -> Unit) {
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        state.error?.let { ErrorBanner(it) }
        if (state.message.isNotBlank()) Text(state.message, color = Aqua, style = muted())
        if (state.villas.isEmpty()) {
            Text("Noch keine Villa. Tippe auf „Deep Agent“, um eine Idee zu starten.", style = muted(), color = TextMuted)
        }
        Spacer(Modifier.height(10.dp))
        LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(state.villas, key = { it.id }) { villa ->
                Card(villa.name, villa.idea.take(120), villa.status) {
                    OutlinedButton(onClick = { onOpen(villa.id) }) { Text("Öffnen") }
                }
            }
        }
    }
}

/* ----------------------------- Erstellen ----------------------------- */

@Composable
private fun CreateVillaScreen(state: UiState, viewModel: MainViewModel, onCreated: (Long) -> Unit) {
    var name by remember { mutableStateOf("") }
    var idea by remember { mutableStateOf("") }
    var count by remember { mutableStateOf("24") }
    var sourcePath by remember { mutableStateOf("") }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        state.error?.let { ErrorBanner(it) }
        Text("Neue Villa & Deep Agent", fontWeight = FontWeight.Bold)
        Text(
            "Der Deep Agent plant die Idee, baut einen Agentenpool auf und öffnet danach den Chat.",
            style = muted(), color = TextMuted
        )
        OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Titel") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(value = idea, onValueChange = { idea = it }, label = { Text("Idee / Ziel") }, modifier = Modifier.fillMaxWidth(), minLines = 4)
        OutlinedTextField(
            value = count,
            onValueChange = { count = it.filter { c -> c.isDigit() } },
            label = { Text("Anzahl Agenten (3–1000)") },
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = sourcePath,
            onValueChange = { sourcePath = it },
            label = { Text("Bestehende App analysieren (Pfad, optional)") },
            placeholder = { Text("/pfad/zur/app") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true
        )
        Text(
            if (sourcePath.isBlank())
                "Ohne Pfad wird neu gebaut. Mit Pfad prüfen die Agenten den echten Code und entscheiden, ob ein sauberer Neubau oder eine Optimierung sinnvoll ist."
            else
                "Die Agenten lesen den Code unter diesem Pfad, erstellen einen Analysebericht und richten den Plan auf Umsatz aus.",
            style = muted(), color = TextMuted
        )
        Button(
            onClick = {
                val n = (count.toIntOrNull() ?: 24).coerceIn(3, 1000)
                viewModel.createVilla(name, idea, n, sourcePath, onCreated)
            },
            enabled = idea.isNotBlank() && !state.busy,
            modifier = Modifier.fillMaxWidth()
        ) { Text("Deep Agent starten") }
    }
}

/* ----------------------------- Detail ----------------------------- */

@Composable
private fun DetailScreen(state: UiState, viewModel: MainViewModel, onChat: () -> Unit) {
    val detail = state.detail ?: return

    // Waehrend eines Durchlaufs den Fortschritt regelmaessig nachladen.
    LaunchedEffect(detail.villa.id, detail.running, detail.villa.status) {
        if (detail.running || detail.villa.status == "RUNNING" || detail.villa.status == "STOPPING") {
            while (true) {
                kotlinx.coroutines.delay(4000)
                viewModel.refreshDetail()
            }
        }
    }

    val active = detail.running || detail.villa.status == "RUNNING" || detail.villa.status == "STOPPING"

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        state.error?.let { ErrorBanner(it) }
        if (state.message.isNotBlank()) Text(state.message, color = Aqua, style = muted())

        Spacer(Modifier.height(8.dp))
        Text(detail.villa.name, fontWeight = FontWeight.Bold)
        Text(detail.villa.idea, style = muted(), color = TextMuted)
        if (detail.villa.sourcePath.isNotBlank()) {
            Text("Projekt: ${detail.villa.sourcePath} · Modus ${detail.villa.mode}", style = muted(), color = TextMuted)
        }

        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Stat("Status", detail.villa.status + if (detail.running) " · läuft" else "")
            Stat("Agenten", "${detail.agents.size}/${detail.villa.maxAgents}")
        }
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Stat("Aufgaben", "${detail.tasks.count { it.status == "DONE" }}/${detail.tasks.size}")
            Stat("Gedächtnis", "${detail.memories.size}")
            Stat("Berichte", "${detail.reports.size}")
        }

        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onChat) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = null)
                Spacer(Modifier.width(6.dp)); Text("Chat")
            }
            if (active) {
                Button(
                    onClick = { viewModel.stop() },
                    enabled = !state.busy && detail.villa.status != "STOPPING",
                    colors = ButtonDefaults.buttonColors(containerColor = Danger)
                ) {
                    Icon(Icons.Filled.Stop, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text(if (detail.villa.status == "STOPPING") "Stoppt …" else "Stoppen")
                }
            } else {
                Button(
                    onClick = { viewModel.orchestrate() },
                    enabled = !state.busy,
                    colors = ButtonDefaults.buttonColors(containerColor = Aqua, contentColor = Ink)
                ) {
                    Icon(Icons.Filled.PlayArrow, contentDescription = null)
                    Spacer(Modifier.width(6.dp)); Text("Entwicklung starten")
                }
            }
        }
        if (detail.villa.sourcePath.isNotBlank()) {
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = { viewModel.analyze() }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Filled.Refresh, contentDescription = null)
                Spacer(Modifier.width(6.dp)); Text("Projekt erneut analysieren")
            }
        }

        val villaEvents = state.events.filter { it.villaId == detail.villa.id }
        if (villaEvents.isNotEmpty()) {
            Section("Live-Ereignisse" + if (state.live) " · verbunden" else "") {
                villaEvents.take(20).forEach { event -> EventRow(event) }
            }
        }

        if (detail.reports.isNotEmpty()) {
            Section("Berichte") {
                detail.reports.forEach { report -> ReportCard(report) }
            }
        }
        Section("Aufgaben") { detail.tasks.forEach { TaskRow(it) } }
        Section("Agenten") { detail.agents.take(60).forEach { AgentRow(it) } }
        Section("Gedächtnis") { detail.memories.take(40).forEach { MemoryRow(it) } }
    }
}

@Composable
private fun ReportCard(report: Report) {
    var open by remember { mutableStateOf(report.kind == "ANALYSIS" || report.kind == "REVENUE") }
    Column(
        Modifier.fillMaxWidth().padding(vertical = 6.dp)
            .background(Surface2, RoundedCornerShape(10.dp)).padding(12.dp)
    ) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Text(report.kind, color = Aqua, style = muted())
                Text(report.title, fontWeight = FontWeight.Bold)
            }
            TextButton(onClick = { open = !open }) { Text(if (open) "Zuklappen" else "Anzeigen") }
        }
        if (open) {
            Spacer(Modifier.height(6.dp))
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                report.content.lines().forEach { line ->
                    val t = line.trim()
                    when {
                        t.isEmpty() -> Spacer(Modifier.height(2.dp))
                        t.startsWith("## ") -> Text(t.removePrefix("## "), color = Aqua, fontWeight = FontWeight.Bold)
                        t.startsWith("- ") || t.startsWith("* ") -> Row {
                            Text("•  ", color = Aqua); Text(t.drop(2))
                        }
                        Regex("^\\d+\\.\\s").containsMatchIn(t) -> Text(t, color = TextMuted)
                        else -> Text(t)
                    }
                }
            }
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Spacer(Modifier.height(16.dp))
    Text(title, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(6.dp))
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) { content() }
}

@Composable
private fun TaskRow(task: Task) =
    RowCard(task.title, task.description + if (task.result.isNotBlank()) "\n→ " + task.result.take(240) else "", task.status)

@Composable
private fun AgentRow(agent: Agent) =
    RowCard(agent.name + if (agent.isRoot) " · Deep Agent" else "", "Rolle: ${agent.role}", agent.status)

@Composable
private fun MemoryRow(memory: Memory) =
    RowCard(memory.title, memory.content.take(240), "${memory.kind} · ${memory.importance}/10")

/* ----------------------------- Chat ----------------------------- */

@Composable
private fun ChatScreen(state: UiState, viewModel: MainViewModel) {
    var input by remember { mutableStateOf("") }
    val listState = rememberLazyListState()

    // Ans Ende springen, sobald neue Nachrichten eintreffen.
    LaunchedEffect(state.messages.size) {
        if (state.messages.isNotEmpty()) listState.animateScrollToItem(state.messages.lastIndex)
    }

    Column(
        Modifier
            .fillMaxSize()
            .imePadding()
    ) {
        state.error?.let { ErrorBanner(it) }
        if (state.message.isNotBlank()) {
            Text(
                state.message,
                color = Aqua,
                style = muted(),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)
            )
        }

        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            if (state.messages.isEmpty()) {
                item {
                    Text(
                        "Schreibe dem Deep Agent eine Nachricht. Er kennt den Stand der Villa und antwortet mit einem Plan.",
                        style = muted(),
                        color = TextMuted
                    )
                }
            }
            items(state.messages) { ChatBubble(it) }
            if (state.busy) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(6.dp)) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = Aqua)
                        Spacer(Modifier.width(8.dp))
                        Text("Deep Agent arbeitet …", style = muted(), color = TextMuted)
                    }
                }
            }
        }

        HorizontalDivider(color = Surface2)

        val villaId = state.detail?.villa?.id
        val lastEvent = state.events.firstOrNull { it.villaId == villaId }
        if (lastEvent != null) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(Surface2)
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                LiveDot(state.live)
                Spacer(Modifier.width(6.dp))
                Text(lastEvent.text, style = muted(), color = TextMuted, modifier = Modifier.weight(1f))
                Text(time(lastEvent.ts), style = muted(), color = TextMuted)
            }
        }

        Row(
            Modifier
                .fillMaxWidth()
                .background(Surface1)
                .padding(10.dp),
            verticalAlignment = Alignment.Bottom
        ) {
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                placeholder = { Text("Nachricht an den Deep Agent") },
                modifier = Modifier.weight(1f),
                maxLines = 5
            )
            Spacer(Modifier.width(8.dp))
            Button(
                onClick = { if (input.isNotBlank()) { viewModel.sendChat(input); input = "" } },
                enabled = input.isNotBlank() && !state.busy,
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 14.dp)
            ) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Senden") }
        }
    }
}

@Composable
private fun ChatBubble(message: ChatMessage) {
    val isUser = message.role == "user"
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start
    ) {
        Column(
            Modifier
                .then(if (isUser) Modifier.fillMaxWidth(0.86f) else Modifier.fillMaxWidth())
                .clip(RoundedCornerShape(14.dp))
                .background(if (isUser) Violet.copy(alpha = 0.22f) else Surface1)
                .padding(12.dp)
        ) {
            Text(
                if (isUser) "Du" else "Agent · " + time(message.createdAt),
                style = muted(),
                color = TextMuted,
                fontWeight = FontWeight.SemiBold
            )
            Spacer(Modifier.height(6.dp))
            if (isUser) Text(message.content) else RichText(message.content)
        }
    }
}

/**
 * Stellt Agentenantworten uebersichtlich dar: Zeilen mit "## " werden zu
 * Abschnittsueberschriften, "- " und "1. " bleiben als Listen erhalten.
 */
@Composable
private fun RichText(text: String) {
    val blocks = remember(text) { parseBlocks(text) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        blocks.forEach { block ->
            when (block) {
                is Block.Heading -> Text(
                    block.text,
                    fontWeight = FontWeight.Bold,
                    color = Aqua,
                    style = MaterialTheme.typography.titleMedium
                )
                is Block.Bullet -> Row(Modifier.fillMaxWidth()) {
                    Text("•  ", color = Violet, fontWeight = FontWeight.Bold)
                    Text(block.text, modifier = Modifier.weight(1f))
                }
                is Block.Numbered -> Row(Modifier.fillMaxWidth()) {
                    Text("${block.number}.  ", color = Violet, fontWeight = FontWeight.Bold)
                    Text(block.text, modifier = Modifier.weight(1f))
                }
                is Block.Paragraph -> Text(block.text)
            }
        }
    }
}

private sealed interface Block {
    data class Heading(val text: String) : Block
    data class Bullet(val text: String) : Block
    data class Numbered(val number: String, val text: String) : Block
    data class Paragraph(val text: String) : Block
}

private fun parseBlocks(text: String): List<Block> {
    val blocks = mutableListOf<Block>()
    val numbered = Regex("^(\\d+)[.)]\\s+(.*)$")
    text.split('\n').forEach { raw ->
        val line = raw.trim()
        if (line.isEmpty()) return@forEach
        val match = numbered.find(line)
        when {
            line.startsWith("## ") -> blocks += Block.Heading(line.removePrefix("## ").trim())
            line.startsWith("# ") -> blocks += Block.Heading(line.removePrefix("# ").trim())
            line.startsWith("- ") || line.startsWith("* ") || line.startsWith("• ") ->
                blocks += Block.Bullet(line.drop(2).trim())
            match != null -> blocks += Block.Numbered(match.groupValues[1], match.groupValues[2])
            else -> blocks += Block.Paragraph(line)
        }
    }
    return blocks.ifEmpty { listOf(Block.Paragraph(text)) }
}

/* ----------------------------- Einstellungen ----------------------------- */

@Composable
private fun SettingsScreen(state: UiState, viewModel: MainViewModel) {
    var url by remember { mutableStateOf(state.serverUrl) }
    var keyName by remember { mutableStateOf("") }
    var keyValue by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        state.error?.let { ErrorBanner(it) }
        if (state.message.isNotBlank()) Text(state.message, color = Aqua, style = muted())

        Text("Hub-Adresse", fontWeight = FontWeight.Bold)
        OutlinedTextField(value = url, onValueChange = { url = it }, label = { Text("https://…") }, modifier = Modifier.fillMaxWidth())
        Button(onClick = { viewModel.saveServerUrl(url) }, modifier = Modifier.fillMaxWidth()) { Text("Verbinden") }

        Spacer(Modifier.height(4.dp))
        Text("Hub-Token (optional)", fontWeight = FontWeight.Bold)
        Text(
            "Nur nötig, wenn der Hub mit VF_TOKEN gestartet wurde. Wird nur im privaten App-Speicher gehalten.",
            style = muted(), color = TextMuted
        )
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text("Bearer-Token, leer = kein Schutz") },
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth()
        )
        Button(
            onClick = { viewModel.saveApiToken(token); token = "" },
            enabled = token.isNotBlank(),
            modifier = Modifier.fillMaxWidth()
        ) { Text("Token speichern") }

        Spacer(Modifier.height(8.dp))
        Text("API-Key hinterlegen", fontWeight = FontWeight.Bold)
        Text(
            "Der Key wird ausschließlich an den Hub gesendet und dort gespeichert – nie auf dem Gerät abgelegt.",
            style = muted(), color = TextMuted
        )
        OutlinedTextField(value = keyName, onValueChange = { keyName = it }, label = { Text("Name, z. B. GROQ_API_KEY") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(
            value = keyValue,
            onValueChange = { keyValue = it },
            label = { Text("Wert") },
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth()
        )
        Button(
            onClick = { if (keyName.isNotBlank() && keyValue.isNotBlank()) { viewModel.saveSecret(keyName, keyValue); keyValue = "" } },
            enabled = keyName.isNotBlank() && keyValue.isNotBlank(),
            modifier = Modifier.fillMaxWidth()
        ) { Text("Key speichern") }

        Spacer(Modifier.height(8.dp))
        Text("LLM-Routen", fontWeight = FontWeight.Bold)
        state.routes.forEach { RouteRow(it) { viewModel.toggleRoute(it) } }
    }
}

@Composable
private fun RouteRow(route: LlmRoute, onToggle: () -> Unit) {
    RowCard(
        title = route.name,
        subtitle = "${route.provider} · ${route.model}\nPrio ${route.priority} · ok ${route.ok} / fail ${route.fail}",
        badge = when {
            route.provider == "offline" -> "offline"
            route.hasKey -> "Key vorhanden"
            else -> "kein Key"
        },
        trailing = { Switch(checked = route.enabled, onCheckedChange = { onToggle() }) }
    )
}

/* ----------------------------- Bausteine ----------------------------- */

@Composable
private fun Card(title: String, subtitle: String, badge: String, content: @Composable () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Surface1)
            .padding(14.dp)
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(title, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Badge(badge)
        }
        if (subtitle.isNotBlank()) {
            Spacer(Modifier.height(4.dp))
            Text(subtitle, style = muted(), color = TextMuted)
        }
        Spacer(Modifier.height(10.dp))
        content()
    }
}

@Composable
private fun RowCard(title: String, subtitle: String, badge: String, trailing: (@Composable () -> Unit)? = null) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(Surface1)
            .padding(12.dp)
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(title, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            if (trailing != null) trailing() else Badge(badge)
        }
        if (subtitle.isNotBlank()) {
            Spacer(Modifier.height(4.dp))
            Text(subtitle, style = muted(), color = TextMuted)
        }
    }
}

/** Kleiner Puls-Punkt: gruen verbunden, grau getrennt (SSE-Status). */
@Composable
private fun LiveDot(connected: Boolean) {
    val color = if (connected) Aqua else TextMuted
    Box(Modifier.size(8.dp).clip(CircleShape).background(color))
}

/** Eine Zeile im Live-Ereignis-Feed (SSE-Ticker). */
@Composable
private fun EventRow(event: VillaEvent) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(Surface2)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(event.type, color = Aqua, style = muted(), fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.width(10.dp))
        Text(event.text, style = muted(), modifier = Modifier.weight(1f), color = TextMain)
        Spacer(Modifier.width(8.dp))
        Text(time(event.ts), style = muted(), color = TextMuted)
    }
}

@Composable
private fun Badge(text: String) {
    val color = when (text) {
        "RUNNING", "DONE", "Key vorhanden" -> Aqua
        "COMPLETED" -> Violet
        "FAILED" -> Danger
        "PAUSED", "PLANNING", "kein Key" -> Warn
        else -> TextMuted
    }
    Row(
        Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(color.copy(alpha = 0.16f))
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(color))
        Spacer(Modifier.width(6.dp))
        Text(text, style = muted(), color = color)
    }
}

@Composable
private fun Stat(label: String, value: String) {
    Column(
        Modifier.clip(RoundedCornerShape(12.dp)).background(Surface2).padding(horizontal = 12.dp, vertical = 8.dp)
    ) {
        Text(value, fontWeight = FontWeight.Bold)
        Text(label, style = muted(), color = TextMuted)
    }
}

@Composable
private fun ErrorBanner(text: String) {
    Text(text, color = Danger, style = muted(), modifier = Modifier.padding(bottom = 8.dp))
}

private fun time(ts: Long): String =
    SimpleDateFormat("HH:mm", Locale.GERMANY).format(Date(if (ts > 0) ts else System.currentTimeMillis()))
