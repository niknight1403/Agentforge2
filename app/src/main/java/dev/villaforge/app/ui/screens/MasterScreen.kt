package dev.villaforge.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.villaforge.app.ui.MainViewModel
import dev.villaforge.app.ui.UiState
import dev.villaforge.app.ui.theme.*

@Composable
fun MasterScreen(state: UiState, viewModel: MainViewModel, suggestedPrompt: String = "", onPromptUsed: () -> Unit = {}) {
    var input by rememberSaveable { mutableStateOf("") }
    var expanded by rememberSaveable { mutableStateOf(false) }
    val listState = rememberLazyListState()
    LaunchedEffect(Unit) { viewModel.loadMaster() }
    LaunchedEffect(suggestedPrompt) { if (suggestedPrompt.isNotBlank()) { input = suggestedPrompt; onPromptUsed() } }
    LaunchedEffect(state.masterMessages.size) {
        if (state.masterMessages.isNotEmpty()) listState.animateScrollToItem(state.masterMessages.lastIndex)
    }
    val proposals = (0 until state.masterSuggestions.length()).map { state.masterSuggestions.getJSONObject(it) }
    Column(Modifier.fillMaxSize().imePadding().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Deine Zentrale für VillaForge", style = MaterialTheme.typography.titleLarge)
        Text("Villen, Prompts, Werkzeuge, Features und eigene Erweiterungen über Nachrichten verwalten.", style = muted(), color = TextMuted)
        state.masterStatus?.let { status ->
            Text("${status.optJSONArray("villas")?.length() ?: 0} Villen · ${status.optJSONArray("archived")?.length() ?: 0} archiviert · ${status.optJSONArray("skills")?.length() ?: 0} Skills", style = muted(), color = Aqua)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Weniger" else "Fähigkeiten") }
            TextButton(onClick = { input = "Zeige die doppelten Villen und ihren Status." }, enabled = !state.masterPending) { Text("Dubletten prüfen") }
        }
        if (expanded) Text("Der Master kann Villen samt Projektauftrag anlegen, Packs und einzelne Werkzeuge schalten, Skills speichern und Einstellungen ändern. Connectoren unterstützen öffentliche HTTPS-JSON-Schnittstellen. OAuth/MCP benötigen ihre Einrichtung. Keine Schlüsselwerte im Chat eingeben.", style = muted(), color = TextMuted)
        if (proposals.isNotEmpty()) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            proposals.forEach { proposal ->
                SuggestionChip(onClick = { if (!state.masterPending) input = proposal.optString("prompt") }, label = { Text(proposal.optString("title")) })
            }
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = listState, verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(vertical = 8.dp)) {
            if (state.masterMessages.isEmpty()) item { Text("Beginne mit „Status“ oder „Erstelle Villa \"Name\": Dein Ziel“.", color = TextMuted) }
            items(state.masterMessages) { message ->
                Column(Modifier.fillMaxWidth().background(if (message.role == "user") Surface2 else Surface1, RoundedCornerShape(14.dp)).padding(14.dp)) {
                    Text(if (message.role == "user") "Du" else "Master-Agent", style = muted(), color = Aqua)
                    Spacer(Modifier.height(6.dp))
                    Text(message.content, style = MaterialTheme.typography.bodyMedium, color = TextMain)
                }
            }
        }
        state.masterError?.let { error -> ErrorBanner(error) { if (state.masterPending) viewModel.sendMaster("") else viewModel.loadMaster() } }
        if (state.masterBusy) LinearProgressIndicator(Modifier.fillMaxWidth(), color = Aqua)
        Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(value = input, onValueChange = { if (it.length <= 8000) input = it }, enabled = !state.masterBusy && !state.masterPending,
                label = { Text("Nachricht an den Master") }, minLines = 2, maxLines = 5, modifier = Modifier.weight(1f))
            Button(onClick = { viewModel.sendMaster(if (state.masterPending) "" else input); if (!state.masterPending) input = "" },
                enabled = !state.masterBusy && (state.masterPending || input.isNotBlank()), modifier = Modifier.heightIn(min = 56.dp)) {
                Text(if (state.masterPending) "Status prüfen" else "Senden")
            }
        }
    }
}
