package dev.villaforge.app.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.villaforge.app.ui.MainViewModel
import dev.villaforge.app.ui.UiState
import dev.villaforge.app.ui.components.AnimatedStatTile
import dev.villaforge.app.ui.components.EmptyState
import dev.villaforge.app.ui.components.MiniBars
import dev.villaforge.app.ui.components.SectionCard
import dev.villaforge.app.ui.components.SectionHeader
import dev.villaforge.app.ui.components.StatusPill
import dev.villaforge.app.ui.theme.Aqua
import dev.villaforge.app.ui.theme.Success
import dev.villaforge.app.ui.theme.TextMuted
import dev.villaforge.app.ui.theme.Violet
import dev.villaforge.app.ui.theme.Warn
import dev.villaforge.app.net.VillaEvent

/* Mission Control (v1.14.0): animierte Kennzahlen, SectionCards. */
@Composable
fun DashboardScreen(state: UiState, viewModel: MainViewModel, onBack: () -> Unit) {
    val packsOn = remember { mutableStateMapOf("monitoring" to true, "analytics" to true, "council" to true, "superintelligence" to true) }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        state.error?.let { ErrorBanner(it) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Mission Control", fontWeight = FontWeight.Bold, style = androidx.compose.material3.MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.weight(1f))
            LiveDot(state.live)
            Spacer(Modifier.width(6.dp))
            StatusPill(state.healthText)
        }

        val s = state.stats
        val open = s?.optJSONObject("tasks")?.optInt("open") ?: 0
        val done = (s?.optJSONObject("tasks")?.optInt("total") ?: 0) - open

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AnimatedStatTile("Villen", state.villas.size, Aqua, Modifier.weight(1f))
            AnimatedStatTile("Agenten", s?.optInt("agents") ?: 0, Violet, Modifier.weight(1f))
            AnimatedStatTile("Offen", open, Warn, Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AnimatedStatTile("Erledigt", done, Success, Modifier.weight(1f))
            AnimatedStatTile("Gedächtnis", s?.optInt("memories") ?: 0, Aqua, Modifier.weight(1f))
            AnimatedStatTile("Rat-Runden", s?.optInt("councilRounds") ?: 0, Violet, Modifier.weight(1f))
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AnimatedStatTile("Laufzeit (h)", (s?.optLong("uptimeSec", 0L) ?: 0L).toInt() / 3600, Aqua, Modifier.weight(1f))
            AnimatedStatTile("Audit-Zeilen", s?.optInt("audit") ?: 0, Violet, Modifier.weight(1f))
            AnimatedStatTile("Nachrichten", s?.optInt("messages") ?: 0, Warn, Modifier.weight(1f))
        }

        /* Sprint 16: echte Marktreife-Daten aus GET /api/stats statt Platzhalter. */
        if (packsOn["analytics"] == true && s != null) {
            val maturity = s.optJSONArray("maturity")
            if (maturity != null && maturity.length() > 0) {
                SectionHeader("Marktreife je Villa")
                MiniBars((0 until maturity.length()).map { i -> maturity.optJSONObject(i)?.optInt("score", 0)?.toFloat() ?: 0f })
                (0 until maturity.length()).forEach { i ->
                    val m = maturity.optJSONObject(i) ?: return@forEach
                    Text(
                        "• ${m.optString("name").take(22)}: ${m.optInt("score")}/100 · ${m.optString("stage")}",
                        style = muted(), color = TextMuted
                    )
                }
            }
        }

        if (packsOn["council"] == true) {
            SectionHeader("Rat der Agenten")
            /* Sprint 19: Villa fuer den Rat auswaehlen statt stillschweigend die erste. */
            var councilVillaId by remember { mutableStateOf<Long?>(null) }
            val councilVilla = councilVillaId ?: state.villas.firstOrNull()?.id
            if (state.villas.size > 1) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())
                ) {
                    state.villas.forEach { villa ->
                        FilterChip(
                            selected = villa.id == councilVilla,
                            onClick = { councilVillaId = villa.id },
                            label = { Text(villa.name.take(16)) }
                        )
                    }
                }
            }
            LaunchedEffect(councilVilla) { councilVilla?.let { id -> viewModel.refreshCouncil(id) } }
            val council = state.council
            if (council != null && council.length() > 0) {
                val last = council.optJSONObject(0)
                SectionCard("Runde ${last?.optInt("round") ?: "–"} · ${last?.optJSONArray("proposals")?.length() ?: 0} Vorschläge") {
                    val arr = last?.optJSONArray("proposals")
                    (0 until (arr?.length() ?: 0)).forEach { i ->
                        val p = arr?.optJSONObject(i)
                        Text("• ${p?.optString("agent")}: ${p?.optString("text")}", style = muted(), color = TextMuted)
                    }
                }
            } else {
                Text(
                    "Noch keine Rat-Runde. Starte sie hier oder warte auf den automatischen Loop (alle 2 Stunden).",
                    style = muted(), color = TextMuted
                )
            }
            if (councilVilla != null) {
                Button(onClick = { viewModel.triggerCouncil(councilVilla) }, enabled = !state.busy) {
                    Icon(Icons.Filled.PlayArrow, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text("Rat jetzt einberufen")
                }
            }
        }

        /* Sprint 15: globaler Ereignis-Feed mit Villa-Filter und Leeren-Button. */
        SectionHeader("Live-Ereignisse")
        if (state.events.isEmpty()) {
            Text("Noch keine Live-Ereignisse empfangen.", style = muted(), color = TextMuted)
        } else {
            var eventFilter by remember { mutableStateOf<Long?>(null) }
            val shownEvents = if (eventFilter == null) state.events
                else state.events.filter { it.villaId == eventFilter }
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())
            ) {
                FilterChip(selected = eventFilter == null, onClick = { eventFilter = null }, label = { Text("Alle") })
                state.villas.forEach { villa ->
                    FilterChip(
                        selected = eventFilter == villa.id,
                        onClick = { eventFilter = villa.id },
                        label = { Text(villa.name.take(14)) }
                    )
                }
            }
            shownEvents.take(15).forEach { event -> EventRow(event) }
            TextButton(onClick = { viewModel.clearEvents() }) { Text("Feed leeren") }
        }

        if (packsOn["superintelligence"] == true) {
            SectionCard("Superintelligenz-Loop aktiv") {
                Text(
                    "Der Hub beruft den Rat automatisch ein. Erkenntnisse fließen als Erinnerungen in alle Agenten — die Villa optimiert sich fortlaufend selbst weiter.",
                    style = muted(), color = TextMuted
                )
            }
        }

        if (state.message.isNotBlank()) Text(state.message, color = Aqua, style = muted())
    }
}
