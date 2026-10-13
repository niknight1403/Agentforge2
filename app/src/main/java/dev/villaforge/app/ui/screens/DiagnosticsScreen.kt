package dev.villaforge.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.villaforge.app.ui.MainViewModel
import dev.villaforge.app.ui.UiState
import dev.villaforge.app.ui.components.KeyRow
import dev.villaforge.app.ui.components.SectionCard
import dev.villaforge.app.ui.components.StatusBadge
import dev.villaforge.app.ui.theme.Aqua
import dev.villaforge.app.ui.theme.TextMuted

/*
 * Diagnose (v1.14.0, neu): alle Verbindungsdaten auf einen Blick — der
 * erste Blick bei Verbindungsproblemen, bevor man graben muss.
 */
@Composable
fun DiagnosticsScreen(state: UiState, viewModel: MainViewModel) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        state.error?.let { ErrorBanner(it) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Diagnose", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.weight(1f))
            LiveDot(state.live)
            Spacer(Modifier.width(6.dp))
            StatusBadge(state.healthText)
        }

        SectionCard("Verbindung") {
            KeyRow("Hub", state.serverUrl)
            KeyRow("Status", if (state.online) "verbunden" else "getrennt")
            KeyRow("Live-Feed (SSE)", if (state.live) "verbunden" else "getrennt")
            KeyRow("Hub-Health", state.healthText)
            KeyRow("Angemeldet", viewModel.loggedInEmail.ifBlank { "–" })
        }

        SectionCard("Routen") {
            if (state.routes.isEmpty()) {
                Text("Keine Routen geladen.", style = muted(), color = TextMuted)
            } else {
                state.routes.forEach { r ->
                    KeyRow(
                        r.name,
                        "${r.model} · Prio ${r.priority} · ok ${r.ok}/fail ${r.fail}" +
                            if (r.enabled) "" else " · aus"
                    )
                }
            }
        }

        SectionCard("Letzte Ereignisse") {
            if (state.events.isEmpty()) {
                Text("Noch keine Live-Ereignisse empfangen.", style = muted(), color = TextMuted)
            } else {
                state.events.take(15).forEach { EventRow(it) }
            }
        }

        Button(onClick = { viewModel.refreshAll() }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
            Text("Verbindung jetzt testen")
        }
        if (state.message.isNotBlank()) Text(state.message, color = Aqua, style = muted())
    }
}
