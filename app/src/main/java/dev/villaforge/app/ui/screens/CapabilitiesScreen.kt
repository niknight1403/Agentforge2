package dev.villaforge.app.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.villaforge.app.ui.MainViewModel
import dev.villaforge.app.ui.UiState
import dev.villaforge.app.ui.components.SectionCard
import dev.villaforge.app.ui.theme.*
import org.json.JSONArray
import org.json.JSONObject

private fun JSONArray?.objects(): List<JSONObject> =
    (0 until (this?.length() ?: 0)).mapNotNull { this?.optJSONObject(it) }

private fun JSONObject.isEnabled(): Boolean = when (val raw = opt("enabled")) {
    is Boolean -> raw
    is Number -> raw.toInt() != 0
    else -> false
}

/** Zeigt ausschliesslich vom Hub gemeldete Faehigkeiten und deren echten Zustand. */
@Composable
fun CapabilitiesScreen(state: UiState, viewModel: MainViewModel, onOpenMaster: (String) -> Unit) {
    var tab by rememberSaveable { mutableStateOf(0) }
    var skillId by rememberSaveable { mutableStateOf("") }
    var skillTitle by rememberSaveable { mutableStateOf("") }
    var skillInstructions by rememberSaveable { mutableStateOf("") }
    var connectorId by rememberSaveable { mutableStateOf("") }
    var connectorTitle by rememberSaveable { mutableStateOf("") }
    var connectorUrl by rememberSaveable { mutableStateOf("") }
    var connectorSecret by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(Unit) { viewModel.loadCapabilities() }

    val status = state.masterStatus
    val packs = status?.optJSONObject("packs")
    val features = packs?.optJSONArray("features").objects()
    val toolPacks = packs?.optJSONArray("tools").objects()
    val tools = status?.optJSONArray("tools").objects()
    val skills = status?.optJSONArray("skills").objects()
    val connectors = status?.optJSONArray("connectors").objects()
    val canEdit = status != null && !state.masterBusy && state.online
    val tabs = listOf("Packs", "Werkzeuge", "Skills", "Connectoren")

    LazyColumn(
        modifier = Modifier.fillMaxSize().imePadding(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            Text("Deine KI-Werkstatt", style = MaterialTheme.typography.headlineSmall, color = TextMain)
            Text("Sieh, was der Hub wirklich kann. Änderungen wirken direkt auf die Agenten.",
                style = MaterialTheme.typography.bodyMedium, color = TextMuted)
            Spacer(Modifier.height(10.dp))
            Text(
                if (!state.online) "Hub offline · Einstellungen nicht verfügbar"
                else if (status == null) "Funktionen werden geladen"
                else "${features.size + toolPacks.size} Packs · ${tools.count { it.isEnabled() }} Werkzeuge aktiv · ${skills.size} Skills · ${connectors.size} Connectoren",
                color = if (state.online) Aqua else Danger,
                style = MaterialTheme.typography.bodySmall
            )
            if (state.masterBusy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp))
            state.masterError?.let { error -> ErrorBanner(error) { viewModel.loadCapabilities() } }
            if (state.message.isNotBlank()) Text(state.message, color = Aqua, style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = { viewModel.loadCapabilities() }, enabled = !state.masterBusy) { Text("Status aktualisieren") }
        }
        item {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                tabs.forEachIndexed { index, title ->
                    FilterChip(selected = tab == index, onClick = { tab = index }, label = { Text(title) })
                }
            }
        }
        if (status == null && !state.masterBusy) item {
            Text("Melde dich mit einem Admin-Konto an und prüfe die Hub-Verbindung.", color = TextMuted)
        }
        when (tab) {
            0 -> {
                item { SectionCard("Feature- und Werkzeug-Packs") {
                    Text("Der Hauptschalter eines Werkzeug-Packs sperrt auch einzeln aktivierte Werkzeuge.",
                        style = MaterialTheme.typography.bodySmall, color = TextMuted)
                } }
                items(features + toolPacks, key = { "pack-${it.optString("id")}" }) { pack ->
                    val id = pack.optString("id")
                    val effective = pack.optBoolean("effective", true)
                    SectionCard(pack.optString("title", id)) {
                        Text(pack.optString("description"), style = MaterialTheme.typography.bodySmall, color = TextMuted)
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(if (pack.isEnabled() && effective) "Aktiv" else if (pack.isEnabled()) "Durch Hauptschalter blockiert" else "Aus",
                                modifier = Modifier.weight(1f), color = if (pack.isEnabled() && effective) Success else Warn)
                            Switch(checked = pack.isEnabled(), enabled = canEdit, onCheckedChange = { enabled ->
                                viewModel.updateCapability("set_pack", JSONObject().put("id", id).put("enabled", enabled))
                            })
                        }
                    }
                }
            }
            1 -> {
                item { SectionCard("Einzelne Werkzeuge") {
                    Text("Für die Ausführung muss auch das zugehörige Pack aktiv sein.",
                        style = MaterialTheme.typography.bodySmall, color = TextMuted)
                } }
                items(tools, key = { "tool-${it.optString("name")}" }) { tool ->
                    val name = tool.optString("name")
                    SectionCard(name.replace('_', ' ')) {
                        Text(tool.optString("description"), style = MaterialTheme.typography.bodySmall, color = TextMuted)
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(if (tool.isEnabled()) "Freigegeben" else "Gesperrt", modifier = Modifier.weight(1f),
                                color = if (tool.isEnabled()) Success else Warn)
                            Switch(checked = tool.isEnabled(), enabled = canEdit, onCheckedChange = { enabled ->
                                viewModel.updateCapability("set_tool", JSONObject().put("name", name).put("enabled", enabled))
                            })
                        }
                    }
                }
            }
            2 -> {
                item { SectionCard("Skill speichern") {
                    Text("Skills sind Arbeitsanweisungen für den Master. Aktive Skills teilen sich ein Limit von 12.000 Zeichen.",
                        style = MaterialTheme.typography.bodySmall, color = TextMuted)
                    OutlinedTextField(value = skillId, onValueChange = { skillId = it.take(64) }, label = { Text("ID, z. B. marktcheck") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = skillTitle, onValueChange = { skillTitle = it.take(120) }, label = { Text("Titel") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = skillInstructions, onValueChange = { skillInstructions = it.take(8000) },
                        label = { Text("Klare Arbeitsanweisung") }, minLines = 3, modifier = Modifier.fillMaxWidth())
                    Button(onClick = {
                        viewModel.updateCapability("upsert_skill", JSONObject().put("id", skillId.trim())
                            .put("title", skillTitle.trim()).put("instructions", skillInstructions.trim()).put("enabled", true))
                    }, enabled = canEdit && skillId.isNotBlank() && skillTitle.isNotBlank() && skillInstructions.isNotBlank()) {
                        Text("Skill speichern")
                    }
                } }
                if (skills.isEmpty()) item { Text("Noch keine Skills gespeichert.", color = TextMuted) }
                items(skills, key = { "skill-${it.optString("id")}" }) { skill ->
                    SectionCard(skill.optString("title")) {
                        Text(skill.optString("id"), color = TextMuted, style = MaterialTheme.typography.labelSmall)
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(if (skill.isEnabled()) "Aktiv" else "Aus", modifier = Modifier.weight(1f), color = TextMuted)
                            TextButton(onClick = {
                                skillId = skill.optString("id")
                                skillTitle = skill.optString("title")
                                skillInstructions = skill.optString("instructions")
                            }) { Text("Bearbeiten") }
                            Switch(checked = skill.isEnabled(), enabled = canEdit, onCheckedChange = { enabled ->
                                viewModel.updateCapability("upsert_skill", JSONObject()
                                    .put("id", skill.optString("id")).put("title", skill.optString("title"))
                                    .put("instructions", skill.optString("instructions")).put("enabled", enabled))
                            })
                        }
                    }
                }
            }
            else -> {
                item { SectionCard("HTTPS-JSON-Connector hinzufügen") {
                    Text("Nur öffentliche HTTPS-JSON-Endpunkte. Ein Connector gilt erst nach erfolgreichem Test als verbunden. Keine Schlüsselwerte eingeben.",
                        style = MaterialTheme.typography.bodySmall, color = TextMuted)
                    OutlinedTextField(value = connectorId, onValueChange = { connectorId = it.take(64) }, label = { Text("ID, z. B. kunden_api") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = connectorTitle, onValueChange = { connectorTitle = it.take(120) }, label = { Text("Name") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = connectorUrl, onValueChange = { connectorUrl = it.take(1000) }, label = { Text("https://…/daten.json") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = connectorSecret, onValueChange = { connectorSecret = it.take(80) },
                        label = { Text("Secret-Name (optional, nie den Wert)") }, modifier = Modifier.fillMaxWidth())
                    Button(onClick = {
                        viewModel.updateCapability("upsert_connector", JSONObject()
                            .put("id", connectorId.trim()).put("title", connectorTitle.trim())
                            .put("endpoint", connectorUrl.trim()).put("secretEnv", connectorSecret.trim())
                            .put("enabled", true), "${connectorUrl.trim()} ${connectorSecret.trim()}")
                    }, enabled = canEdit && connectorId.isNotBlank() && connectorTitle.isNotBlank() && connectorUrl.startsWith("https://")) {
                        Text("Connector speichern")
                    }
                    Text("OAuth und MCP benötigen weiterhin eine eigene Einrichtung.", color = TextMuted, style = MaterialTheme.typography.bodySmall)
                } }
                if (connectors.isEmpty()) item { Text("Noch keine Connectoren konfiguriert.", color = TextMuted) }
                items(connectors, key = { "connector-${it.optString("id")}" }) { connector ->
                    val id = connector.optString("id")
                    val statusText = connector.optString("last_status", "configured")
                    SectionCard(connector.optString("title", id)) {
                        Text(connector.optString("endpoint"), color = TextMuted, style = MaterialTheme.typography.bodySmall)
                        Text(when (statusText) {
                            "connected" -> "Verbindung geprüft"
                            "error" -> "Letzter Test fehlgeschlagen"
                            else -> "Konfiguriert · noch nicht geprüft"
                        }, color = if (statusText == "connected") Success else Warn, style = MaterialTheme.typography.bodySmall)
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            TextButton(onClick = { viewModel.updateCapability("test_connector", JSONObject().put("id", id)) },
                                enabled = canEdit && connector.isEnabled()) { Text("Verbindung testen") }
                            Spacer(Modifier.weight(1f))
                            Switch(checked = connector.isEnabled(), enabled = canEdit, onCheckedChange = { enabled ->
                                viewModel.updateCapability("upsert_connector", JSONObject()
                                    .put("id", id).put("title", connector.optString("title"))
                                    .put("endpoint", connector.optString("endpoint"))
                                    .put("secretEnv", connector.optString("secret_env")).put("enabled", enabled),
                                    "${connector.optString("endpoint")} ${connector.optString("secret_env")}")
                            })
                        }
                    }
                }
            }
        }
        item {
            TextButton(onClick = { onOpenMaster("Zeige Status und schlage die nächsten sinnvollen Schritte vor.") },
                modifier = Modifier.fillMaxWidth()) { Text("Mit dem Master weiterarbeiten →") }
        }
    }
}
