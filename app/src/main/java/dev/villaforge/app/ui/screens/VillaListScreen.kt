package dev.villaforge.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.RoundedCornerShape
import dev.villaforge.app.ui.theme.NeonCyan
import dev.villaforge.app.ui.theme.Danger
import dev.villaforge.app.ui.theme.Gold
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.villaforge.app.ui.MainViewModel
import dev.villaforge.app.ui.UiState
import dev.villaforge.app.ui.components.EmptyState
import dev.villaforge.app.ui.components.SkeletonList
import dev.villaforge.app.ui.theme.Aqua
import dev.villaforge.app.ui.theme.Surface1
import dev.villaforge.app.ui.theme.TextMain
import dev.villaforge.app.ui.theme.TextMuted
import dev.villaforge.app.ui.theme.Violet

@Composable
fun VillaListScreen(state: UiState, viewModel: MainViewModel? = null, onOpen: (Long) -> Unit) {
    var search by rememberSaveable { mutableStateOf("") }
    var statusFilter by rememberSaveable { mutableStateOf("") }
    var sortMode by rememberSaveable { mutableStateOf("neu") }
    val lifecycleOwner = LocalLifecycleOwner.current
    val online by rememberUpdatedState(state.online)
    viewModel?.let { vm ->
        LaunchedEffect(vm, lifecycleOwner) {
            lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                while (true) {
                    kotlinx.coroutines.delay(30_000)
                    if (online) vm.refreshAll()
                }
            }
        }
    }
    val filtered = state.villas.filter { villa ->
        (statusFilter.isEmpty() || villa.status == statusFilter) &&
            (search.isBlank() || villa.name.contains(search, ignoreCase = true) || villa.idea.contains(search, ignoreCase = true))
    }
    val visible = when (sortMode) {
        "name" -> filtered.sortedBy { it.name.lowercase() }
        "status" -> filtered.sortedWith(compareBy({ it.status }, { it.name.lowercase() }))
        else -> filtered.sortedByDescending { it.id }
    }

    Column(Modifier.fillMaxSize()) {
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(top = 14.dp, bottom = 88.dp)
        ) {
            item { state.error?.let { ErrorBanner(it) { viewModel?.refreshAll() } } }
            item { ControlCenterHero() }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    MetricTile("Villen", state.villas.size.toString(), "⌂", Violet, Modifier.weight(1f))
                    MetricTile("Agenten im Pool", state.stats?.optInt("agents", 0)?.toString() ?: "0", "◆", Aqua, Modifier.weight(1f))
                    MetricTile("Routen", state.routes.size.toString(), "↗", Color(0xFFFFB020), Modifier.weight(1f))
                }
            }
            item {
                val aktiv = state.villas.count { it.executing }
                val warten = state.villas.count { it.queued }
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    if (aktiv + warten > 0) {
                        Text("$aktiv arbeiten", color = Aqua, style = muted(), fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
                        Text(" · $warten warten", color = androidx.compose.ui.graphics.Color(0xFFFFB020), style = muted())
                        Spacer(Modifier.width(10.dp))
                    }
                    LiveDot(state.live)
                    Spacer(Modifier.width(7.dp))
                    Text(
                        if (state.lastRefresh > 0) state.healthText + " · Stand " + time(state.lastRefresh) else state.healthText,
                        style = muted(), color = TextMuted, modifier = Modifier.weight(1f)
                    )
                    Text("${visible.size}/${state.villas.size}", style = muted(), color = TextMuted)
                }
            }
            item {
                OutlinedTextField(
                    value = search, onValueChange = { search = it },
                    label = { Text("Villen durchsuchen") }, placeholder = { Text("Name oder Idee") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }
            item {
                FilterRow(
                    options = listOf("Alle" to "", "Läuft" to "RUNNING", "Pausiert" to "PAUSED", "Fertig" to "COMPLETED", "Fehler" to "FAILED"),
                    selected = statusFilter, onSelect = { statusFilter = it }
                )
            }
            item {
                FilterRow(
                    options = listOf("Neueste" to "neu", "Name" to "name", "Status" to "status"),
                    selected = sortMode, onSelect = { sortMode = it }
                )
            }
            when {
                state.villas.isEmpty() && state.busy -> item { SkeletonList(rows = 4) }
                state.villas.isEmpty() && !state.online -> item { EmptyState(title = "Hub nicht verbunden", hint = "Prüfe die Serveradresse in den Einstellungen und versuche es erneut.") }
                state.villas.isEmpty() -> item { EmptyState(title = "Noch keine Villa", hint = "Tippe unten auf „Deep Agent“ und starte deine erste autonome Entwicklung.") }
                visible.isEmpty() -> item { EmptyState(title = "Kein Treffer", hint = "Passe Suche oder Status-Filter an, um alle Villen wieder zu sehen.") }
                else -> items(visible, key = { it.id }) { villa ->
                    Card(villa.name, villa.idea.take(110), villa.displayStatus(), onClick = { onOpen(villa.id) }) {
                        if (villa.executing) {
                            Text(
                                (villa.runningTasks.firstOrNull() ?: "arbeitet an Aufgaben") + "  ·  ≈ ${villa.etaMin} Min",
                                style = muted(), color = Aqua, fontSize = 12.sp
                            )
                        } else if (villa.queued) {
                            Text(
                                "wartet auf freien Rechen-Slot  ·  ${villa.openCount} offen · ≈ ${villa.etaMin} Min",
                                style = muted(), color = androidx.compose.ui.graphics.Color(0xFFFFB020), fontSize = 12.sp
                            )
                        } else if (villa.openCount > 0) {
                            Text("${villa.openCount} offen · ≈ ${villa.etaMin} Min", style = muted(), color = TextMuted, fontSize = 12.sp)
                        }
                        if (villa.vision.isNotBlank()) {
                            Text("Ziel: " + villa.vision, style = muted(), color = androidx.compose.ui.graphics.Color(0xFF00A3FF), fontSize = 12.sp, maxLines = 2)
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Projekt öffnen", color = Aqua, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                            Spacer(Modifier.weight(1f))
                            if (viewModel != null) {
                                val vid = villa.id
                                if (villa.executing) {
                                    Text(
                                        "■  STOPP", color = Danger, fontWeight = FontWeight.ExtraBold, fontSize = 13.sp,
                                        modifier = Modifier.clip(RoundedCornerShape(50))
                                            .background(Color(0x1AFF5F6D))
                                            .clickable { viewModel.stopVilla(vid) }
                                            .padding(horizontal = 14.dp, vertical = 8.dp)
                                    )
                                } else {
                                    Text(
                                        "▶  START", color = NeonCyan, fontWeight = FontWeight.ExtraBold, fontSize = 13.sp,
                                        modifier = Modifier.clip(RoundedCornerShape(50))
                                            .background(Color(0x1400FFD1))
                                            .clickable { viewModel.startVilla(vid) }
                                            .padding(horizontal = 14.dp, vertical = 8.dp)
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ControlCenterHero() {
    Box(
        Modifier.fillMaxWidth().clip(MaterialTheme.shapes.large)
            .background(Brush.linearGradient(listOf(Color(0xFF241A63), Color(0xFF102F4E), Color(0xFF092A35))))
            .padding(20.dp)
    ) {
        Box(Modifier.align(Alignment.TopEnd).size(116.dp).clip(CircleShape).background(Gold.copy(alpha = 0.10f)))
        Column {
            Text("DEEP-AGENT CONTROL CENTER", color = Gold, style = MaterialTheme.typography.labelSmall)
            Spacer(Modifier.height(8.dp))
            Text("Deine Idee.", color = TextMain, fontSize = 28.sp, fontWeight = FontWeight.Bold)
            Text("Deine Villa.", color = Color(0xFFB9A6FF), fontSize = 28.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(7.dp))
            Text("Planung, Chat und Umsetzung in einem fokussierten Entwicklungsraum.", color = TextMuted, style = muted())
        }
    }
}

@Composable
private fun MetricTile(label: String, value: String, icon: String, accent: Color, modifier: Modifier = Modifier) {
    Column(modifier.clip(MaterialTheme.shapes.medium).background(Surface1).padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(28.dp).clip(CircleShape).background(accent.copy(alpha = 0.16f)), contentAlignment = Alignment.Center) {
                Text(icon, color = accent, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.width(8.dp))
            Text(value, color = TextMain, fontSize = 19.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.height(5.dp))
        Text(label, color = TextMuted, style = muted())
    }
}

@Composable
private fun FilterRow(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(7.dp), modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
        options.forEach { (label, value) ->
            FilterChip(selected = selected == value, onClick = { onSelect(value) }, label = { Text(label) })
        }
    }
}
