package dev.villaforge.app.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.villaforge.app.ui.MainViewModel
import dev.villaforge.app.ui.UiState
import dev.villaforge.app.ui.components.EmptyState
import dev.villaforge.app.ui.components.SkeletonList
import dev.villaforge.app.ui.theme.Aqua
import dev.villaforge.app.ui.theme.TextMuted

/*
 * Villen-Liste (v1.21.0): Suche, Status-Filter, Live-Standzeile mit
 * Stand-Stempel und Auto-Aktualisierung alle 30 s im Vordergrund.
 */
@Composable
fun VillaListScreen(state: UiState, viewModel: MainViewModel? = null, onOpen: (Long) -> Unit) {
    var search by remember { mutableStateOf("") }
    var statusFilter by remember { mutableStateOf("") }
    /* Sprint 25: Sortierung Neueste / Name / Status. */
    var sortMode by remember { mutableStateOf("neu") }

    /* Sprint 14: regelmaeßige Hintergrunderneuerung, solange die Liste sichtbar ist. */
    viewModel?.let { vm ->
        LaunchedEffect(Unit) {
            while (true) {
                kotlinx.coroutines.delay(30_000)
                if (state.online) vm.refreshAll()
            }
        }
    }

    val filtered = state.villas.filter { villa ->
        (statusFilter.isEmpty() || villa.status == statusFilter) &&
            (search.isBlank() || villa.name.contains(search, ignoreCase = true) ||
                villa.idea.contains(search, ignoreCase = true))
    }
    val visible = when (sortMode) {
        "name" -> filtered.sortedBy { it.name.lowercase() }
        "status" -> filtered.sortedWith(compareBy({ it.status }, { it.name.lowercase() }))
        else -> filtered.sortedByDescending { it.id }
    }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        state.error?.let { ErrorBanner(it) { viewModel?.refreshAll() } }
        if (state.message.isNotBlank()) Text(state.message, color = Aqua, style = muted())

        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            LiveDot(state.live)
            Spacer(Modifier.width(6.dp))
            Text(
                if (state.lastRefresh > 0) state.healthText + " · Stand " + time(state.lastRefresh)
                else state.healthText,
                style = muted(), color = TextMuted, modifier = Modifier.weight(1f)
            )
            Text("${visible.size}/${state.villas.size}", style = muted(), color = TextMuted)
        }
        Spacer(Modifier.height(8.dp))

        OutlinedTextField(
            value = search,
            onValueChange = { search = it },
            placeholder = { Text("Villen durchsuchen") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(Modifier.height(6.dp))
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())
        ) {
            for ((label, value) in listOf(
                "Alle" to "", "Läuft" to "RUNNING", "Pausiert" to "PAUSED", "Fehlgeschlagen" to "FAILED"
            )) {
                FilterChip(
                    selected = statusFilter == value,
                    onClick = { statusFilter = value },
                    label = { Text(label) }
                )
            }
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())
        ) {
            for ((label, value) in listOf("Neueste" to "neu", "Name" to "name", "Status" to "status")) {
                FilterChip(
                    selected = sortMode == value,
                    onClick = { sortMode = value },
                    label = { Text(label) }
                )
            }
        }
        Spacer(Modifier.height(10.dp))

        when {
            state.villas.isEmpty() && !state.online -> SkeletonList(rows = 4)
            state.villas.isEmpty() -> EmptyState(
                title = "Noch keine Villa",
                hint = "Tippe unten auf „Deep Agent“ und gib eine Idee ein — der Rest passiert autonom."
            )
            visible.isEmpty() -> EmptyState(
                title = "Kein Treffer",
                hint = "Passe Suche oder Status-Filter an, um alle Villen wieder zu sehen."
            )
            else -> {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(visible, key = { it.id }) { villa ->
                        Card(villa.name, villa.idea.take(120), villa.status, onClick = { onOpen(villa.id) }) {
                            OutlinedButton(onClick = { onOpen(villa.id) }) { Text("Öffnen") }
                        }
                    }
                }
            }
        }
    }
}
