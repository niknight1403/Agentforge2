package dev.villaforge.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.villaforge.app.net.Agent
import dev.villaforge.app.net.Memory
import dev.villaforge.app.net.Report
import dev.villaforge.app.net.Task
import dev.villaforge.app.ui.MainViewModel
import dev.villaforge.app.ui.UiState
import dev.villaforge.app.ui.components.AnimatedStatTile
import dev.villaforge.app.ui.components.RingProgress
import dev.villaforge.app.ui.components.StackedBar
import dev.villaforge.app.ui.components.SectionCard
import dev.villaforge.app.ui.components.StatusBadge
import dev.villaforge.app.ui.theme.Aqua
import dev.villaforge.app.ui.theme.Danger
import dev.villaforge.app.ui.theme.Ink
import dev.villaforge.app.ui.theme.TextMuted

/* Detail-Ansicht (v1.14.0): animierte Kennzahlen, semantische Badges. */
@Composable
fun DetailScreen(state: UiState, viewModel: MainViewModel, onChat: () -> Unit, onDeleted: () -> Unit, onDev: () -> Unit = {}) {
    val detail = state.detail ?: return
    var showDelete by remember { mutableStateOf(false) }
    var showEdit by remember { mutableStateOf(false) }
    val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current

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
        state.error?.let { ErrorBanner(it) { viewModel.refreshAll() } }
        if (state.message.isNotBlank()) Text(state.message, color = Aqua, style = muted())

        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(detail.villa.name, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            StatusBadge(if (detail.running) (if (detail.villa.executing) "ARBEITET" else detail.villa.status + " · läuft") else detail.villa.displayStatus())
            if (detail.villa.executing && detail.villa.runningTasks.isNotEmpty()) {
                Text(detail.villa.runningTasks.first(), style = androidx.compose.material3.MaterialTheme.typography.labelSmall, color = androidx.compose.ui.graphics.Color(0xFF00E6C2), fontSize = 11.sp)
            }
        }
        Text(detail.villa.idea, style = muted(), color = TextMuted)
        if (detail.villa.sourcePath.isNotBlank()) {
            Text("Projekt: ${detail.villa.sourcePath} · Modus ${detail.villa.mode}", style = muted(), color = TextMuted)
        }

        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AnimatedStatTile("Agenten", detail.agents.size, Aqua, Modifier.weight(1f))
            AnimatedStatTile("Aufgaben", detail.tasks.size, dev.villaforge.app.ui.theme.Violet, Modifier.weight(1f))
            AnimatedStatTile("Erledigt", detail.tasks.count { it.status == "DONE" }, dev.villaforge.app.ui.theme.Success, Modifier.weight(1f))
        }
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AnimatedStatTile("Gedächtnis", detail.memories.size, Aqua, Modifier.weight(1f))
            AnimatedStatTile("Berichte", detail.reports.size, dev.villaforge.app.ui.theme.Violet, Modifier.weight(1f))
            Stat("Status", detail.villa.status)
        }

        /* Sprint 32: Fortschrittsring fuer den Aufgaben-Abschluss. */
        Spacer(Modifier.height(8.dp))
        val doneCount = detail.tasks.count { it.status == "DONE" }
        val pct = if (detail.tasks.isEmpty()) 0 else (doneCount * 100) / detail.tasks.size
        Row(verticalAlignment = Alignment.CenterVertically) {
            RingProgress(pct, if (pct >= 100) dev.villaforge.app.ui.theme.Success else Aqua)
            Spacer(Modifier.width(12.dp))
            Column {
                Text("$pct % erledigt", fontWeight = FontWeight.Bold)
                Text("$doneCount von ${detail.tasks.size} Aufgaben", style = muted(), color = TextMuted)
            }
        }
        if (state.stale) {
            Text("Offline · zeige letzten Stand", style = muted(), color = dev.villaforge.app.ui.theme.Warn)
        }

        /* Kostenloser KI-Designer: passendes Bild zur Villa. */
        dev.villaforge.app.ui.components.HeroImage(
            idea = detail.villa.idea, seed = detail.villa.id,
            modifier = Modifier.fillMaxWidth().height(140.dp)
        )
        Spacer(Modifier.height(10.dp))

        state.product?.let { prod ->
            MaturityCard(prod)
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
                    Icon(Icons.Filled.Stop, contentDescription = "Villa stoppen")
                    Spacer(Modifier.width(6.dp))
                    Text(if (detail.villa.status == "STOPPING") "Stoppt …" else "Stoppen")
                }
            } else {
                Button(
                    onClick = {
                        haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                        viewModel.orchestrate()
                    },
                    enabled = !state.busy,
                    colors = ButtonDefaults.buttonColors(containerColor = Aqua, contentColor = Ink)
                ) {
                    Icon(Icons.Filled.PlayArrow, contentDescription = "Entwicklung starten")
                    Spacer(Modifier.width(6.dp)); Text("Entwicklung starten")
                }
            }
        }
        /* Entwicklungsbereich: Chat, Live-Ansicht, autonome Fertigstellung, APK-Build. */
        Spacer(Modifier.height(8.dp))
        Button(
            onClick = onDev,
            enabled = !state.busy,
            colors = ButtonDefaults.buttonColors(containerColor = dev.villaforge.app.ui.theme.Violet, contentColor = Ink),
            modifier = Modifier.fillMaxWidth()
        ) {
            Icon(Icons.Filled.Edit, contentDescription = "Entwicklungsbereich öffnen")
            Spacer(Modifier.width(6.dp)); Text("Entwicklungsbereich")
        }
        if (detail.villa.sourcePath.isNotBlank()) {
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = { viewModel.analyze() }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Filled.Refresh, contentDescription = "Projekt erneut analysieren")
                Spacer(Modifier.width(6.dp)); Text("Projekt erneut analysieren")
            }
        }
        if (detail.tasks.any { it.status == "FAILED" }) {
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = { viewModel.retryFailed() }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Fehlgeschlagene Aufgaben erneut starten")
                Spacer(Modifier.width(6.dp)); Text("Fehlgeschlagene Aufgaben erneut starten")
            }
        }

        Spacer(Modifier.height(8.dp))
        val context = LocalContext.current
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = {
                    viewModel.export { json ->
                        val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                            type = "application/json"
                            putExtra(android.content.Intent.EXTRA_TEXT, json)
                        }
                        context.startActivity(android.content.Intent.createChooser(send, "Villa-Export"))
                    }
                },
                enabled = !state.busy,
                modifier = Modifier.weight(1f)
            ) {
                Icon(Icons.Filled.Share, contentDescription = "Villa-Export teilen")
                Spacer(Modifier.width(6.dp)); Text("Export")
            }
            OutlinedButton(
                onClick = { showEdit = true },
                enabled = !state.busy,
                modifier = Modifier.weight(1f)
            ) {
                Icon(Icons.Filled.Edit, contentDescription = "Villa bearbeiten")
                Spacer(Modifier.width(6.dp)); Text("Bearbeiten")
            }
            if (!active) {
                OutlinedButton(
                    onClick = { showDelete = true },
                    enabled = !state.busy,
                    modifier = Modifier.weight(1f)
                ) {
                    Icon(Icons.Filled.Delete, contentDescription = "Villa löschen")
                    Spacer(Modifier.width(6.dp)); Text("Löschen")
                }
            }
        }

        if (showDelete) {
            AlertDialog(
                onDismissRequest = { showDelete = false },
                title = { Text("Villa löschen?") },
                text = { Text("\"${detail.villa.name}\" mitsamt Agenten, Aufgaben und Berichten endgültig löschen.") },
                confirmButton = {
                    TextButton(onClick = {
                        haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                        showDelete = false; viewModel.delete(); onDeleted()
                    }) { Text("Löschen") }
                },
                dismissButton = {
                    TextButton(onClick = { showDelete = false }) { Text("Abbrechen") }
                }
            )
        }

        if (showEdit) {
            var editName by remember { mutableStateOf(detail.villa.name) }
            var editIdea by remember { mutableStateOf(detail.villa.idea) }
            AlertDialog(
                onDismissRequest = { showEdit = false },
                title = { Text("Villa bearbeiten") },
                text = {
                    Column {
                        OutlinedTextField(value = editName, onValueChange = { editName = it }, label = { Text("Name") }, singleLine = true)
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(value = editIdea, onValueChange = { editIdea = it }, label = { Text("Idee") }, minLines = 2)
                    }
                },
                confirmButton = {
                    TextButton(
                        onClick = { showEdit = false; viewModel.editVilla(editName.trim(), editIdea.trim()) },
                        enabled = editName.isNotBlank() && editIdea.isNotBlank()
                    ) { Text("Speichern") }
                },
                dismissButton = {
                    TextButton(onClick = { showEdit = false }) { Text("Abbrechen") }
                }
            )
        }

        val villaEvents = state.events.filter { it.villaId == detail.villa.id }
        if (villaEvents.isNotEmpty()) {
            Section("Live-Ereignisse" + if (state.live) " · verbunden" else "") {
                villaEvents.take(20).forEach { event -> EventRow(event) }
            }
        }

        if (detail.reports.isNotEmpty()) {
            SectionCard("Berichte") {
                /* Sprint 22: Berichte filtern und zaehlen. */
                var reportSearch by remember { mutableStateOf("") }
                OutlinedTextField(
                    value = reportSearch,
                    onValueChange = { reportSearch = it },
                    placeholder = { Text("Berichte durchsuchen") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(6.dp))
                val reportMatches = detail.reports.filter {
                    reportSearch.isBlank() || it.title.contains(reportSearch, ignoreCase = true) ||
                        it.content.contains(reportSearch, ignoreCase = true) ||
                        it.kind.contains(reportSearch, ignoreCase = true)
                }
                Text("${reportMatches.size} von ${detail.reports.size} Berichten", style = muted(), color = TextMuted)
                reportMatches.forEach { report -> ReportCard(report) }
            }
        }
        Section("Aufgaben") {
            var taskFilter by remember { mutableStateOf("") }
            StackedBar(
                listOf(
                    "DONE" to dev.villaforge.app.ui.theme.Success,
                    "RUNNING" to Aqua,
                    "REVIEW" to dev.villaforge.app.ui.theme.Warn,
                    "PENDING" to dev.villaforge.app.ui.theme.Violet,
                    "READY" to TextMuted,
                    "BLOCKED" to dev.villaforge.app.ui.theme.Warn,
                    "FAILED" to dev.villaforge.app.ui.theme.Danger
                ).map { (s, c) -> detail.tasks.count { it.status == s } to c },
                Modifier.fillMaxWidth().height(6.dp)
            )
            Spacer(Modifier.height(4.dp))
            /* Sprint 37: Legende zu den Statusfarben des Balkens. */
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                for ((status, color) in listOf(
                    "DONE" to dev.villaforge.app.ui.theme.Success, "RUNNING" to Aqua,
                    "PENDING" to dev.villaforge.app.ui.theme.Violet, "FAILED" to dev.villaforge.app.ui.theme.Danger
                )) {
                    val n = detail.tasks.count { it.status == status }
                    if (n > 0) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(
                                Modifier.width(8.dp).height(8.dp)
                                    .background(color, RoundedCornerShape(2.dp))
                            ) {}
                            Spacer(Modifier.width(3.dp))
                            Text("$status $n", style = muted(), color = TextMuted)
                        }
                    }
                }
            }
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for ((label, value) in listOf(
                    "Alle" to "", "Offen" to "PENDING", "Läuft" to "RUNNING",
                    "Erledigt" to "DONE", "Fehler" to "FAILED", "Blockiert" to "BLOCKED"
                )) {
                    FilterChip(
                        selected = taskFilter == value,
                        onClick = { taskFilter = value },
                        label = { Text(label) }
                    )
                }
            }
            /* Sprint 21: Textsuche ueber Titel, Beschreibung und Ergebnis. */
            var taskSearch by remember { mutableStateOf("") }
            OutlinedTextField(
                value = taskSearch,
                onValueChange = { taskSearch = it },
                placeholder = { Text("Aufgaben durchsuchen") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(Modifier.height(4.dp))
            val shownTasks = detail.tasks
                .filter { taskFilter.isEmpty() || it.status == taskFilter }
                .filter {
                    taskSearch.isBlank() || it.title.contains(taskSearch, ignoreCase = true) ||
                        it.description.contains(taskSearch, ignoreCase = true) ||
                        it.result.contains(taskSearch, ignoreCase = true)
                }
            Text("${shownTasks.size} von ${detail.tasks.size} Aufgaben", style = muted(), color = TextMuted)
            if (shownTasks.isEmpty()) {
                Text("Keine Aufgaben in dieser Ansicht.", style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
            } else {
                shownTasks.forEach { TaskRow(it) { taskId -> viewModel.retryTask(taskId) } }
            }
        }
        /* Sprint 17: Agenten durchsuchen und zaehlen. */
        Section("Agenten") {
            var agentSearch by remember { mutableStateOf("") }
            OutlinedTextField(
                value = agentSearch,
                onValueChange = { agentSearch = it },
                placeholder = { Text("Agent suchen (Name oder Rolle)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(Modifier.height(6.dp))
            val agentMatches = detail.agents.filter {
                it.name.contains(agentSearch, ignoreCase = true) || it.role.contains(agentSearch, ignoreCase = true)
            }
            Text("${agentMatches.size} von ${detail.agents.size} Agenten", style = muted(), color = TextMuted)
            agentMatches.take(60).forEach { AgentRow(it) }
        }
        /* Sprint 18: Gedächtnis durchsuchen, nach Wichtigkeit sortieren. */
        Section("Gedächtnis") {
            var memSearch by remember { mutableStateOf("") }
            var onlyImportant by remember { mutableStateOf(false) }
            OutlinedTextField(
                value = memSearch,
                onValueChange = { memSearch = it },
                placeholder = { Text("Erinnerungen durchsuchen") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                FilterChip(selected = !onlyImportant, onClick = { onlyImportant = false }, label = { Text("Alle") })
                FilterChip(selected = onlyImportant, onClick = { onlyImportant = true }, label = { Text("Wichtig (≥7)") })
            }
            val memMatches = detail.memories
                .filter { m ->
                    (!onlyImportant || m.importance >= 7) &&
                        (memSearch.isBlank() || m.title.contains(memSearch, ignoreCase = true) ||
                            m.content.contains(memSearch, ignoreCase = true))
                }
                .sortedByDescending { it.importance }
            Text("${memMatches.size} von ${detail.memories.size} Einträgen", style = muted(), color = TextMuted)
            memMatches.take(40).forEach { MemoryRow(it) }
        }
    }
}

@Composable
internal fun ReportCard(report: Report) {
    var open by remember { mutableStateOf(report.kind == "ANALYSIS" || report.kind == "REVENUE") }
    Column(
        Modifier.fillMaxWidth().padding(vertical = 6.dp)
            .background(dev.villaforge.app.ui.theme.Surface2, RoundedCornerShape(10.dp)).padding(12.dp)
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
            val shareContext = androidx.compose.ui.platform.LocalContext.current
            TextButton(onClick = { open = !open }) { Text(if (open) "Zuklappen" else "Anzeigen") }
            TextButton(onClick = {
                val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(android.content.Intent.EXTRA_TEXT, report.title + "\n\n" + report.content)
                }
                shareContext.startActivity(android.content.Intent.createChooser(send, "Bericht teilen"))
            }) { Text("Teilen") }
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
internal fun TaskRow(task: Task, onRetry: (Long) -> Unit = {}) {
    RowCard(task.title, task.description + if (task.result.isNotBlank()) "\n→ " + task.result.take(240) else "", task.status)
    if (task.status == "FAILED") {
        TextButton(onClick = { onRetry(task.id) }) {
            Icon(Icons.Filled.Refresh, contentDescription = null)
            Spacer(Modifier.width(4.dp)); Text("Aufgabe erneut starten")
        }
    }
}

@Composable
internal fun AgentRow(agent: Agent) =
    RowCard(agent.name + if (agent.isRoot) " · Deep Agent" else "", "Rolle: ${agent.role}", agent.status)

@Composable
internal fun MemoryRow(memory: Memory) =
    RowCard(memory.title, memory.content.take(240), "${memory.kind} · ${memory.importance}/10")

/**
 * Marktreife-Karte: Gesamtscore 0-100, Stufe, aktuelle Phase und Fortschritt
 * je Lebenszyklus-Phase (DISCOVERY bis GROWTH) aus GET /api/villas/:id/product.
 */
@Composable
private fun MaturityCard(prod: org.json.JSONObject) {
    val score = prod.optInt("score", 0)
    val stage = prod.optString("stage", "")
    val current = prod.optString("currentPhase", "")
    val phases = prod.optJSONArray("phases") ?: org.json.JSONArray()

    Card(
        title = "Marktreife",
        subtitle = "$score/100 · $stage",
        badge = current,
        content = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                RingProgress(score, if (score >= 90) dev.villaforge.app.ui.theme.Success else Aqua)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text("$score/100 · $stage", fontWeight = FontWeight.Bold)
                    Text("Aktive Phase: $current", style = muted(), color = TextMuted)
                }
            }
            Spacer(Modifier.height(8.dp))
            for (i in 0 until phases.length()) {
                val ph = phases.optJSONObject(i) ?: continue
                val pct = (ph.optDouble("ratio", 0.0) * 100).toInt()
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 3.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        ph.optString("title"),
                        style = muted(),
                        color = if (pct >= 100) dev.villaforge.app.ui.theme.Success else TextMuted,
                        modifier = Modifier.weight(1f)
                    )
                    Text("$pct%", style = muted(), color = TextMuted)
                }
                androidx.compose.foundation.layout.Box(
                    Modifier
                        .fillMaxWidth()
                        .height(4.dp)
                        .background(TextMuted.copy(alpha = 0.15f), RoundedCornerShape(2.dp))
                ) {
                    androidx.compose.foundation.layout.Box(
                        Modifier
                            .fillMaxWidth(pct / 100f)
                            .height(4.dp)
                            .background(
                                if (pct >= 100) dev.villaforge.app.ui.theme.Success else Aqua,
                                RoundedCornerShape(2.dp)
                            )
                    )
                }
            }
        }
    )
}
