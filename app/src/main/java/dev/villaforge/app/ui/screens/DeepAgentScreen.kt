package dev.villaforge.app.ui.screens

import android.content.Context
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.VideoLibrary
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.villaforge.app.ui.MainViewModel
import dev.villaforge.app.ui.UiState
import dev.villaforge.app.ui.components.GlassCard
import dev.villaforge.app.ui.components.NeonChip
import dev.villaforge.app.ui.theme.ElectricBlue
import dev.villaforge.app.ui.theme.NeonCyan
import dev.villaforge.app.ui.theme.NeonPink
import dev.villaforge.app.ui.theme.TextMain
import dev.villaforge.app.ui.theme.TextMuted
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/*
 * DEEP AGENT (v1.37.0): Eigener Entwicklungs-Bereich ABSEITS der Villen.
 * - DeepAgentScreen: Projekt-Verlauf + "Neues Projekt" (App-Idee)
 * - DeepChatScreen: 1:1-Entwicklungs-Chat je Projekt mit "+"
 *   fuer Anhaenge (Foto, Video, Datei, GitHub-Repo, Link).
 * Jeder neue Deep Agent oeffnet ein neues Projekt; die vorherigen
 * Projekte bleiben im Verlauf (mit Gedaechtnis im Hub).
 */

private val fmt = SimpleDateFormat("dd.MM. HH:mm", Locale.getDefault())

@Composable
fun DeepAgentScreen(state: UiState, viewModel: MainViewModel, onOpenProject: (Long) -> Unit, onBack: () -> Unit) {
    LaunchedEffect(Unit) { viewModel.loadDeepProjects() }
    var idea by remember { mutableStateOf("") }
    var showNew by remember { mutableStateOf(false) }
    var deleteProject by remember { mutableStateOf<dev.villaforge.app.net.DeepProject?>(null) }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, "zurueck", tint = TextMain) }
            Column(Modifier.weight(1f)) {
                Text("Deep Agent", fontWeight = FontWeight.ExtraBold, fontSize = 20.sp, color = TextMain)
                Text("Eigene App-Ideen umsetzen - abseits der Villen", style = MaterialTheme.typography.labelSmall, color = TextMuted)
            }
            IconButton(onClick = { showNew = !showNew }) {
                Icon(Icons.Filled.Add, "neues Projekt", tint = NeonCyan)
            }
        }
        Spacer(Modifier.height(8.dp))

        if (showNew || state.deepProjects.isEmpty()) {
            GlassCard(accent = NeonCyan, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.fillMaxWidth().padding(14.dp)) {
                    Text("NEUES PROJEKT", style = MaterialTheme.typography.labelSmall, color = TextMuted, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(6.dp))
                    OutlinedTextField(
                        value = idea,
                        onValueChange = { idea = it },
                        placeholder = { Text("Beschreibe deine App-Idee ...") },
                        modifier = Modifier.fillMaxWidth(),
                        minLines = 2
                    )
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                        TextButton(
                            onClick = {
                                if (idea.isNotBlank()) {
                                    viewModel.createDeepProject(idea) { onOpenProject(it) }
                                    idea = ""
                                    showNew = false
                                }
                            },
                            enabled = idea.isNotBlank() && !state.busy
                        ) { Text(if (state.busy) "Deep Agent startet ..." else "Projekt starten") }
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
        }

        if (state.deepProjects.isEmpty() && !showNew) {
            Box(Modifier.fillMaxWidth().padding(top = 32.dp), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Filled.Folder, null, tint = TextMuted, modifier = Modifier.size(42.dp))
                    Spacer(Modifier.height(8.dp))
                    Text("Noch keine Projekte", color = TextMuted)
                }
            }
        }

        LazyColumn(state = rememberLazyListState(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.deepProjects) { prj ->
                GlassCard(accent = ElectricBlue, modifier = Modifier.fillMaxWidth()) {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(12.dp)) {
                        Column(Modifier.weight(1f).clickable { onOpenProject(prj.id) }) {
                            Text(prj.title, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = TextMain, maxLines = 1)
                            Text(
                                "${prj.messages} Nachrichten · ${if (prj.villaId > 0) "Villa #${prj.villaId}" else fmt.format(Date(prj.updatedAt))}",
                                style = MaterialTheme.typography.labelSmall, color = TextMuted
                            )
                        }
                        NeonChip(prj.status, NeonCyan)
                        IconButton(onClick = { deleteProject = prj }) {
                            Icon(Icons.Filled.Delete, "Projekt löschen", tint = TextMuted)
                        }
                    }
                }
            }
        }
        deleteProject?.let { target ->
            AlertDialog(
                onDismissRequest = { deleteProject = null },
                title = { Text("Deep-Projekt löschen?") },
                text = { Text("\"${target.title}\" samt Chatverlauf und hochgeladenen Dateien endgültig löschen. Eine bereits übergebene Villa bleibt als separates Entwicklungsprojekt erhalten.") },
                confirmButton = {
                    TextButton(onClick = { viewModel.deleteDeepProject(target.id); deleteProject = null }) { Text("Endgültig löschen") }
                },
                dismissButton = { TextButton(onClick = { deleteProject = null }) { Text("Abbrechen") } }
            )
        }
    }
}

@Composable
fun DeepChatScreen(state: UiState, viewModel: MainViewModel, onBack: () -> Unit, onOpenVilla: (Long) -> Unit) {
    val project = state.deepActiveProject ?: run { onBack(); return }
    var input by remember { mutableStateOf("") }
    var showAttachMenu by remember { mutableStateOf(false) }
    var showRepoDialog by remember { mutableStateOf(false) }
    var repoUrl by remember { mutableStateOf("") }
    val listState = rememberLazyListState()
    val context = LocalContext.current
    val projectId = project.id

    /* Nativer Android-Picker: Fotos/Videos und beliebige Dateien */
    val mediaPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) viewModel.addDeepAttachmentFromUri(context, projectId, uri)
    }
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) viewModel.addDeepAttachmentFromUri(context, projectId, uri)
    }

    LaunchedEffect(state.deepMessages.size) {
        if (state.deepMessages.isNotEmpty()) listState.animateScrollToItem(state.deepMessages.size - 1)
    }

    Column(Modifier.fillMaxSize().padding(12.dp).imePadding()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, "zurueck", tint = TextMain) }
            Column(Modifier.weight(1f)) {
                Text(project.title, fontWeight = FontWeight.Bold, fontSize = 15.sp, color = TextMain, maxLines = 1)
                Text("Deep Agent · ${project.status}", style = MaterialTheme.typography.labelSmall, color = TextMuted)
            }
            TextButton(
                onClick = { viewModel.developDeepProject(projectId, onOpenVilla) },
                enabled = !state.busy
            ) {
                Text(if (project.villaId > 0) "Villa öffnen" else "Autonom umsetzen", color = NeonCyan, fontSize = 11.sp)
            }
            if (state.busy) CircularProgressIndicator(Modifier.size(20.dp), color = NeonCyan)
        }
        Spacer(Modifier.height(8.dp))

        LazyColumn(state = listState, modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(state.deepMessages) { msg ->
                val mine = msg.role == "user"
                Row(
                    horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Box(
                        Modifier
                            .fillMaxWidth(if (mine) 0.86f else 0.92f)
                            .clip(RoundedCornerShape(12.dp))
                            .background(if (mine) NeonCyan.copy(alpha = 0.10f) else TextMuted.copy(alpha = 0.07f))
                            .padding(10.dp)
                    ) {
                        Column {
                            Text(msg.content, style = MaterialTheme.typography.bodyMedium, color = TextMain)
                            Text(
                                fmt.format(Date(msg.createdAt)),
                                style = MaterialTheme.typography.labelSmall,
                                color = TextMuted,
                                fontSize = 9.sp
                            )
                        }
                    }
                }
            }
        }

        if (state.deepPendingAttachments.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(vertical = 4.dp)) {
                state.deepPendingAttachments.forEach { a ->
                    NeonChip(
                        "📎 " + a.name.ifBlank { a.url },
                        NeonPink,
                        Modifier.clickable { viewModel.removeDeepAttachment(a.name, a.url) }
                    )
                }
            }
        }

        if (showAttachMenu) {
            GlassCard(accent = NeonPink, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(8.dp)) {
                    Text("ANHANG HINZUFUEGEN", style = MaterialTheme.typography.labelSmall, color = TextMuted, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(4.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        AttachOption(Icons.Filled.Image, "Foto/Video") {
                            showAttachMenu = false
                            mediaPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                        }
                        AttachOption(Icons.Filled.Description, "Datei") {
                            showAttachMenu = false
                            filePicker.launch(arrayOf("*/*"))
                        }
                        AttachOption(Icons.Filled.Link, "GitHub-Repo") { showAttachMenu = false; showRepoDialog = true }
                    }
                    Text(
                        "Foto/Video und Dateien werden direkt hochgeladen (max. 12 MB). GitHub-Repo: URL angeben.",
                        style = MaterialTheme.typography.labelSmall, color = TextMuted, fontSize = 9.sp
                    )
                }
            }
            Spacer(Modifier.height(6.dp))
        }

        if (showRepoDialog) {
            GlassCard(accent = ElectricBlue, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(10.dp)) {
                    Text("GITHUB-REPOSITORY", style = MaterialTheme.typography.labelSmall, color = TextMuted, fontWeight = FontWeight.Bold)
                    OutlinedTextField(
                        value = repoUrl,
                        onValueChange = { repoUrl = it },
                        placeholder = { Text("https://github.com/user/projekt") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true
                    )
                    Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                        TextButton(onClick = { showRepoDialog = false }) { Text("Abbrechen") }
                        TextButton(
                            onClick = {
                                viewModel.addDeepLink("repo", repoUrl)
                                showRepoDialog = false
                                repoUrl = ""
                            },
                            enabled = repoUrl.isNotBlank()
                        ) { Text("Hinzufuegen") }
                    }
                }
            }
            Spacer(Modifier.height(6.dp))
        }

        Row(verticalAlignment = Alignment.Bottom) {
            IconButton(onClick = { showAttachMenu = !showAttachMenu }) {
                Icon(Icons.Filled.Add, "Anhang", tint = if (showAttachMenu) NeonCyan else TextMuted)
            }
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                placeholder = { Text("Nachricht an den Deep Agent ...") },
                modifier = Modifier.weight(1f),
                maxLines = 4
            )
            IconButton(
                onClick = {
                    if (input.isNotBlank()) {
                        viewModel.sendDeep(input)
                        input = ""
                    }
                },
                enabled = input.isNotBlank() && !state.busy
            ) { Icon(Icons.Filled.Send, "senden", tint = NeonCyan) }
        }
    }
}

@Composable
private fun AttachOption(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .clip(RoundedCornerShape(10.dp))
            .clickable { onClick() }
            .padding(8.dp)
    ) {
        Icon(icon, null, tint = NeonCyan, modifier = Modifier.size(22.dp))
        Text(label, style = MaterialTheme.typography.labelSmall, color = TextMain, fontSize = 10.sp)
    }
}
