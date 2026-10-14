package dev.villaforge.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardOptions
import dev.villaforge.app.ui.MainViewModel
import dev.villaforge.app.ui.UiState
import dev.villaforge.app.ui.theme.TextMuted

/*
 * Anmeldung beim ersten Start (v1.14.1): Verlangt der Hub einen Login
 * (HTTP 401) und es gibt keine gespeicherten Zugangsdaten, erscheint dieser
 * Screen automatisch. Nach erfolgreichem Login speichert die App die Daten
 * privat und erneuert die Sitzung kuenftig selbst.
 */
@Composable
fun LoginScreen(state: UiState, viewModel: MainViewModel) {
    var mail by rememberSaveable { mutableStateOf(viewModel.loggedInEmail) }
    var pw by rememberSaveable { mutableStateOf("") }
    /* Sprint 27: Passwort bei Bedarf im Klartext pruefen. */
    var showPw by rememberSaveable { mutableStateOf(false) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.Center
    ) {
        Text("Willkommen bei VillaForge", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        Text(
            "Melde dich mit deinem Hub-Konto an. Die Sitzung wird danach automatisch erneuert; die Zugangsdaten bleiben nur im privaten App-Speicher.",
            style = muted(), color = TextMuted
        )
        Spacer(Modifier.height(20.dp))
        state.error?.let { ErrorBanner(it) }
        OutlinedTextField(
            value = mail, onValueChange = { mail = it }, label = { Text("E-Mail") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email)
        )
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = pw, onValueChange = { pw = it }, label = { Text("Passwort") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
            visualTransformation = if (showPw) androidx.compose.ui.text.input.VisualTransformation.None
                else PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            trailingIcon = {
                TextButton(onClick = { showPw = !showPw }) { Text(if (showPw) "Verbergen" else "Anzeigen") }
            }
        )
        Spacer(Modifier.height(16.dp))
        Button(
            onClick = { viewModel.login(mail, pw); pw = "" },
            enabled = mail.isNotBlank() && pw.isNotBlank() && !state.busy,
            modifier = Modifier.fillMaxWidth()
        ) { Text(if (state.busy) "Melde an …" else "Anmelden") }
        Spacer(Modifier.height(12.dp))
        Text("Hub: ${state.serverUrl}", style = muted(), color = TextMuted)
    }
}
