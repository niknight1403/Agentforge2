package dev.villaforge.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.DesignServices
import androidx.compose.material.icons.filled.RocketLaunch
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import dev.villaforge.app.net.ChatMessage
import dev.villaforge.app.ui.MainViewModel
import dev.villaforge.app.ui.UiState
import dev.villaforge.app.ui.components.NeonChip
import dev.villaforge.app.ui.theme.NeonCyan
import dev.villaforge.app.ui.theme.NeonPink
import dev.villaforge.app.ui.theme.Surface1
import dev.villaforge.app.ui.theme.Surface2
import dev.villaforge.app.ui.theme.TextMain
import dev.villaforge.app.ui.theme.TextMuted

/*
 * MASTER-AGENT-Chat (v1.33.0): eigenes Fenster zum autonomen App-Manager.
 * Wunsch reinschreiben -> der Master baut daraus ein professionelles Prompt,
 * gruendet die Villa, startet die Entwicklung autonom und liefert ein
 * Design-Konzeptbild aus dem kostenlosen Designer-Tool-Pack mit.
 */
@Composable
fun MasterChatScreen(state: UiState, viewModel: MainViewModel, onOpenVilla: (Long) -> Unit) {
    var input by remember { mutableStateOf("") }
    val listState = rememberLazyListState()

    LaunchedEffect(Unit) { viewModel.loadMaster() }
    LaunchedEffect(state.masterMessages.size) {
        if (state.masterMessages.isNotEmpty()) listState.animateScrollToItem(state.masterMessages.lastIndex)
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        /* Kopf: Titel + Status-Chip */
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.AutoAwesome, null, tint = NeonCyan, modifier = Modifier.size(22.dp))
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Text("MASTER-AGENT", fontWeight = FontWeight.ExtraBold, fontSize = 17.sp, color = TextMain)
                Text("Autonome App-Entwicklung · Designer-Tool-Pack", style = MaterialTheme.typography.labelSmall, color = TextMuted)
            }
            NeonChip(if (state.online) "LIVE" else "OFFLINE", if (state.online) NeonCyan else TextMuted)
        }

        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            if (state.masterMessages.isEmpty()) {
                item {
                    Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            "Ich bin dein Master-Agent: Sag mir, was du veraendern oder neu bauen moechtest.",
                            style = MaterialTheme.typography.bodyMedium, color = TextMain
                        )
                        Text(
                            "Ich erstelle und starte Villen mit professionellem Prompt, stoppe, pausiere und starte sie auf Zuruf - und liefere ein Design-Konzeptbild zu jeder Gruendung.",
                            style = MaterialTheme.typography.bodySmall, color = TextMuted
                        )
                        Spacer(Modifier.height(6.dp))
                        SuggestionChip("Erstelle eine App, die meine Termine automatisch plant", Icons.Filled.RocketLaunch) { input = it }
                        SuggestionChip("Ich moechte einen Dark-Mode-Toggle in der Uebersicht", Icons.Filled.DesignServices) { input = it }
                        SuggestionChip("Verbessere die Performance der Villen-Liste", Icons.Filled.AutoAwesome) { input = it }
                        SuggestionChip("Welche Villa arbeitet gerade?", Icons.Filled.RocketLaunch) { input = it }
                        SuggestionChip("Pausiere alle Villen ausser der CyberSarah Villa", Icons.Filled.RocketLaunch) { input = it }
                    }
                }
            }
            items(state.masterMessages) { MasterBubble(it, onOpenVilla, onSelectDesign = { label -> viewModel.sendMaster(label) }) }
            if (state.masterBusy) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(6.dp)) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = NeonCyan)
                        Spacer(Modifier.width(8.dp))
                        Text("Master-Agent arbeitet …", style = MaterialTheme.typography.bodySmall, color = TextMuted)
                    }
                }
            }
        }

        /* Eingabe */
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                placeholder = { Text("Dein Wunsch an den Master-Agenten …") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = {
                    viewModel.sendMaster(input); input = ""
                }),
                modifier = Modifier.weight(1f)
            )
            Spacer(Modifier.width(8.dp))
            IconButton(
                onClick = { viewModel.sendMaster(input); input = "" },
                enabled = input.isNotBlank() && !state.masterBusy
            ) {
                Icon(Icons.AutoMirrored.Filled.Send, "Senden", tint = if (input.isNotBlank()) NeonCyan else TextMuted)
            }
        }
    }
}

@Composable
private fun SuggestionChip(text: String, icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: (String) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .padding(2.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        TextButton(onClick = { onClick(text) }) {
            Icon(icon, null, tint = NeonPink, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            Text(text, style = MaterialTheme.typography.bodySmall, color = TextMain)
        }
    }
}

@Composable
private fun MasterBubble(msg: ChatMessage, onOpenVilla: (Long) -> Unit, onSelectDesign: (String) -> Unit) {
    val mine = msg.role == "user"
    Box(Modifier.fillMaxWidth()) {
        Column(
            Modifier
                .fillMaxWidth(if (mine) 0.85f else 0.92f)
                .align(if (mine) Alignment.CenterEnd else Alignment.CenterStart)
                .clip(RoundedCornerShape(16.dp))
                .padding(2.dp)
        ) {
            Column(
                Modifier
                    .clip(RoundedCornerShape(15.dp))
                    .background(if (mine) Surface1 else Surface2)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text(
                    msg.content,
                    style = MaterialTheme.typography.bodyMedium,
                    color = TextMain
                )
                /* Designer-Tool-Pack: Design-Stilvarianten zur Auswahl (3 Optionen),
                   sonst Rueckfall auf das einzelne Konzeptbild. */
                if (!mine && msg.designVariants.isNotEmpty()) {
                    var selectedKey by remember(msg.createdAt) { mutableStateOf<String?>(null) }
                    Text(
                        "Design-Optionen - tippe dein Favor an:",
                        style = MaterialTheme.typography.labelSmall,
                        color = TextMuted
                    )
                    Spacer(Modifier.height(6.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        msg.designVariants.forEach { v ->
                            val selected = selectedKey == v.key
                            Column(
                                modifier = Modifier
                                    .weight(1f)
                                    .clip(RoundedCornerShape(10.dp))
                                    .background(if (selected) NeonCyan.copy(alpha = 0.16f) else androidx.compose.ui.graphics.Color.Transparent)
                                    .clickable {
                                        selectedKey = v.key
                                        onSelectDesign("Design-Auswahl: ${v.label}")
                                    }
                                    .padding(6.dp)
                            ) {
                                AsyncImage(
                                    model = v.url,
                                    contentDescription = "Design ${v.label}",
                                    contentScale = ContentScale.Crop,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .height(86.dp)
                                        .clip(RoundedCornerShape(8.dp))
                                )
                                Spacer(Modifier.height(4.dp))
                                Text(
                                    v.label + if (selected) "  ✓" else "",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = if (selected) NeonCyan else TextMuted,
                                    modifier = Modifier.fillMaxWidth()
                                )
                            }
                        }
                    }
                } else if (!mine && msg.designImage.isNotBlank()) {
                    AsyncImage(
                        model = msg.designImage,
                        contentDescription = "Design-Konzept",
                        contentScale = ContentScale.Crop,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(140.dp)
                            .clip(RoundedCornerShape(12.dp))
                    )
                }
                if (!mine && msg.villaId > 0) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        NeonChip("VILLA GEGRUENDET", NeonCyan)
                        Spacer(Modifier.width(8.dp))
                        Text(msg.villaName, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, color = TextMain)
                        Spacer(Modifier.weight(1f))
                        TextButton(onClick = { onOpenVilla(msg.villaId) }) { Text("Öffnen ›") }
                    }
                }
            }
        }
    }
}
