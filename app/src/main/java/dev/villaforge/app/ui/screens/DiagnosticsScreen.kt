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
import androidx.compose.material3.OutlinedButton
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

        androidx.compose.runtime.LaunchedEffect(Unit) { viewModel.refreshSecrets() }

        SectionCard("Hub-Secrets") {
            if (state.secrets.isEmpty()) {
                Text("Keine Secrets geladen.", style = muted(), color = TextMuted)
            } else {
                state.secrets.forEach { KeyRow(it, "hinterlegt") }
            }
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
        OutlinedButton(
            onClick = { viewModel.pingHub() },
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth()
        ) { Text("Latenz messen") }
        /* Sprint 24: gesamter Diagnosestand als Text teilbar (Support-Fall). */
        val diagContext = androidx.compose.ui.platform.LocalContext.current
        OutlinedButton(
            onClick = {
                val report = buildString {
                    appendLine("VillaForge Diagnosebericht")
                    appendLine("Zeit: " + time(System.currentTimeMillis()))
                    appendLine()
                    appendLine("Hub: ${state.serverUrl}")
                    appendLine("Status: " + if (state.online) "verbunden" else "getrennt")
                    appendLine("Live-Feed (SSE): " + if (state.live) "verbunden" else "getrennt")
                    appendLine("Health: ${state.healthText}")
                    appendLine("Angemeldet: ${viewModel.loggedInEmail.ifBlank { "–" }}")
                    appendLine()
                    appendLine("Routen:")
                    if (state.routes.isEmpty()) appendLine("  keine geladen")
                    state.routes.forEach { r ->
                        appendLine("  ${r.name}: ${r.model} · Prio ${r.priority} · ok ${r.ok}/fail ${r.fail}" + if (r.enabled) "" else " · aus")
                    }
                    appendLine()
                    appendLine("Hub-Secrets: " + if (state.secrets.isEmpty()) "–" else state.secrets.joinToString(", "))
                    appendLine()
                    appendLine("Letzte Ereignisse:")
                    if (state.events.isEmpty()) appendLine("  keine")
                    state.events.take(15).forEach { e ->
                        appendLine("  [${time(e.ts)}] ${e.text}")
                    }
                }
                val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(android.content.Intent.EXTRA_TEXT, report)
                }
                diagContext.startActivity(android.content.Intent.createChooser(send, "Diagnosebericht teilen"))
            },
            modifier = Modifier.fillMaxWidth()
        ) { Text("Diagnosebericht teilen") }
        if (state.message.isNotBlank()) Text(state.message, color = Aqua, style = muted())
    }
}
