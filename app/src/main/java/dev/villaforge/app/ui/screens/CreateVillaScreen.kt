package dev.villaforge.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.dp
import dev.villaforge.app.ui.MainViewModel
import dev.villaforge.app.ui.UiState
import dev.villaforge.app.ui.components.SectionHeader
import dev.villaforge.app.ui.theme.TextMuted

/* Erstellen (v1.14.0): Deep-Agent-Formular mit Overline-Labels. */
@Composable
fun CreateVillaScreen(state: UiState, viewModel: MainViewModel, onCreated: (Long) -> Unit) {
    var name by remember { mutableStateOf("") }
    var idea by remember { mutableStateOf("") }
    var count by remember { mutableStateOf("24") }
    var sourcePath by remember { mutableStateOf("") }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        state.error?.let { ErrorBanner(it) }
        SectionHeader("Neue Villa & Deep Agent")
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
