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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.villaforge.app.net.LlmRoute
import dev.villaforge.app.ui.FEATURE_PACKS
import dev.villaforge.app.ui.MainViewModel
import dev.villaforge.app.ui.UiState
import dev.villaforge.app.ui.components.KeyRow
import dev.villaforge.app.ui.components.SectionCard
import dev.villaforge.app.ui.components.SectionHeader
import dev.villaforge.app.ui.theme.Aqua
import dev.villaforge.app.ui.theme.TextMuted

/* Einstellungen (v1.14.0): in Sektionskarten geordnet, Overline-Labels. */
@Composable
fun SettingsScreen(state: UiState, viewModel: MainViewModel) {
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

        state.stats?.let { s ->
            SectionCard("Hub-Statistik") {
                val tasksObj = s.optJSONObject("tasks")
                KeyRow("Villen / Agenten", "${s.optInt("villas")} / ${s.optInt("agents")}")
                KeyRow("Aufgaben", "${tasksObj?.optInt("total") ?: 0} (offen ${tasksObj?.optInt("open") ?: 0})")
                KeyRow("Audit / Verläufe", "${s.optInt("audit")} / ${s.optInt("messages")}")
                KeyRow("Laufzeit", "${s.optLong("uptimeSec") / 60} min")
                KeyRow("Speicher", "${s.optLong("rssBytes") / (1024 * 1024)} MB")
                val rh = s.optJSONObject("routesHealth")
                if (rh != null) {
                    val cooling = rh.optJSONArray("cooling")
                    val coolingNames = (0 until (cooling?.length() ?: 0)).mapNotNull { i -> cooling?.optString(i) }
                    KeyRow(
                        "Routen",
                        "ok ${rh.optInt("ok")} / fail ${rh.optInt("fail")}" +
                            if (coolingNames.isEmpty()) "" else "\nIm Cooldown: " + coolingNames.joinToString(", ")
                    )
                }
            }
        }

        SectionHeader("Feature Packs")
        FEATURE_PACKS.forEach { pack ->
            var on by rememberSaveable(pack.id) { mutableStateOf(true) }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(pack.title, fontWeight = FontWeight.SemiBold)
                    Text(pack.desc, style = muted(), color = TextMuted)
                }
                Spacer(Modifier.width(8.dp))
                Switch(checked = on, onCheckedChange = { on = it })
            }
        }
        Spacer(Modifier.padding(4.dp))

        SectionCard("Hub-Adresse") {
            OutlinedTextField(value = url, onValueChange = { url = it }, label = { Text("https://…") }, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.padding(4.dp))
            Button(onClick = { viewModel.saveServerUrl(url) }, modifier = Modifier.fillMaxWidth()) { Text("Verbinden") }
            Spacer(Modifier.padding(4.dp))
            OutlinedButton(onClick = { viewModel.pingHub() }, modifier = Modifier.fillMaxWidth()) { Text("Verbindung testen") }
        }

        SectionCard("Anmeldung") {
            Text(
                "Mit deinem Hub-Konto anmelden. Die Sitzung wird automatisch erneuert; Zugangsdaten bleiben nur im privaten App-Speicher.",
                style = muted(), color = TextMuted
            )
            var loginMail by rememberSaveable { mutableStateOf(viewModel.loggedInEmail) }
            var loginPw by rememberSaveable { mutableStateOf("") }
            OutlinedTextField(value = loginMail, onValueChange = { loginMail = it }, label = { Text("E-Mail") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(
                value = loginPw, onValueChange = { loginPw = it }, label = { Text("Passwort") }, singleLine = true,
                visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth()
            )
            Button(
                onClick = { viewModel.login(loginMail, loginPw); loginPw = "" },
                enabled = loginMail.isNotBlank() && loginPw.isNotBlank(),
                modifier = Modifier.fillMaxWidth()
            ) { Text("Anmelden") }
            if (viewModel.loggedInEmail.isNotBlank()) {
                Spacer(Modifier.padding(4.dp))
                Text("Angemeldet als ${viewModel.loggedInEmail}", style = muted(), color = TextMuted)
                Spacer(Modifier.padding(4.dp))
                OutlinedButton(onClick = { viewModel.logout() }, modifier = Modifier.fillMaxWidth()) { Text("Abmelden") }
            }
        }

        SectionCard("Hub-Token (optional)") {
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
        }

        SectionCard("API-Key hinterlegen") {
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
        }

        SectionHeader("LLM-Routen")
        state.routes.forEach { RouteRow(it) { viewModel.toggleRoute(it) } }
    }
}

@Composable
internal fun RouteRow(route: LlmRoute, onToggle: () -> Unit) {
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
