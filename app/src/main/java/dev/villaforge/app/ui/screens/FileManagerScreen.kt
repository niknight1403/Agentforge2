package dev.villaforge.app.ui.screens

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.security.MessageDigest

private data class PhoneFile(val uri: Uri, val id: String, val parentId: String, val name: String, val mime: String, val size: Long)
private data class FileAction(val title: String, val files: List<PhoneFile>, val folder: String? = null, val delete: Boolean = false)

@Composable
fun FileManagerScreen() {
    val context = LocalContext.current
    val resolver = context.contentResolver
    val prefs = remember { context.getSharedPreferences("phone-file-manager", Context.MODE_PRIVATE) }
    var treeUri by remember { mutableStateOf(prefs.getString("tree", null)?.let(Uri::parse)) }
    var files by remember { mutableStateOf<List<PhoneFile>>(emptyList()) }
    var command by remember { mutableStateOf("") }
    var result by remember { mutableStateOf("Wähle zuerst einen Speicherordner aus. Der Zugriff bleibt auf diesen Ordner begrenzt.") }
    var pending by remember { mutableStateOf<FileAction?>(null) }
    var busy by remember { mutableStateOf(false) }
    var accessStatus by remember { mutableStateOf("Nicht freigegeben") }
    val scope = rememberCoroutineScope()

    fun updateAccessStatus() {
        val grant = treeUri?.let { uri -> context.contentResolver.persistedUriPermissions.firstOrNull { it.uri == uri } }
        accessStatus = when {
            treeUri == null -> "Nicht freigegeben"
            grant == null -> "Zugriff abgelaufen – Ordner erneut freigeben"
            grant.isReadPermission && grant.isWritePermission -> "Lesen und Schreiben freigegeben"
            grant.isReadPermission -> "Nur Lesen freigegeben – Änderungen nicht möglich"
            else -> "Kein gültiger Speicherzugriff"
        }
    }

    LaunchedEffect(treeUri) { updateAccessStatus() }

    fun refresh(root: Uri? = treeUri) {
        root ?: return
        updateAccessStatus()
        val grant = context.contentResolver.persistedUriPermissions.firstOrNull { it.uri == root }
        if (grant?.isReadPermission != true) {
            result = "Kein gültiger Lesezugriff. Bitte den Speicherordner erneut freigeben."
            return
        }
        scope.launch {
            busy = true
            try {
                files = withContext(Dispatchers.IO) { listFiles(context, root) }
                result = "${files.size} Dateien im freigegebenen Ordner gefunden."
            } catch (e: Exception) { result = "Lesefehler: ${e.message}" }
            busy = false
        }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) {
            try {
                val readFlag = android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
                val writeFlag = android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                val writeGranted = runCatching {
                    context.contentResolver.takePersistableUriPermission(uri, readFlag or writeFlag)
                }.isSuccess
                if (!writeGranted) {
                    context.contentResolver.takePersistableUriPermission(uri, readFlag)
                }
                treeUri = uri
                prefs.edit().putString("tree", uri.toString()).apply()
                refresh(uri)
            } catch (e: Exception) { result = "Ordnerzugriff konnte nicht gespeichert werden: ${e.message}" }
        }
    }

    fun plan(text: String) {
        val q = text.trim().lowercase()
        if (q.isBlank()) return
        // Resolve an explicitly named file before interpreting words such as "jpg"
        // as a MIME category. This prevents "Lösche Urlaub.jpg" from selecting every photo.
        val needle = q.replace(
            Regex("^(bitte\\s+)?(lösche|loesche|entferne|zeige|finde|suche|sortiere|ordne|verschiebe)\\s+(die\\s+)?(datei|dateien)?\\s*"),
            ""
        ).trim().trim('"', '\'')
        val exactNamedFiles = if (needle.contains('.')) {
            files.filter { it.name.equals(needle, ignoreCase = true) }
        } else emptyList()
        val isDeleteCommand = listOf("lösch", "loesch", "entfern", "delete").any(q::contains)

        // Bulk intent must be a standalone word, not a substring in a filename.
        val hasExplicitBulkIntent = !needle.contains('.') &&
            Regex("\\b(bild(?:er)?|fotos?|videos?|filme?|musik|audio|spiele?|games?|apk|duplikate?|doppelt)\\b").containsMatchIn(q)
        val hasExplicitDuplicateIntent = !needle.contains('.') &&
            Regex("\\b(duplikate?|doppelt)\\b").containsMatchIn(q)
        val hasExplicitImageIntent = Regex("\\b(bild(?:er)?|fotos?|images?|jpg|png)\\b").containsMatchIn(q)
        val hasExplicitVideoIntent = Regex("\\b(videos?|filme?|mp4)\\b").containsMatchIn(q)
        val hasExplicitAudioIntent = Regex("\\b(musik|audio|mp3)\\b").containsMatchIn(q)
        val hasExplicitGameIntent = Regex("\\b(spiele?|games?|apk)\\b").containsMatchIn(q)

        // Filename deletes (with or without extension) are exact-only. Missing
        // and duplicate basenames fail closed; category and duplicate operations
        // remain available only when the command explicitly names that operation.
        if (isDeleteCommand && !hasExplicitBulkIntent) {
            val exactMatches = files.filter { it.name.equals(needle, ignoreCase = true) }
            when (exactMatches.size) {
                0 -> result = "Keine Datei mit dem exakten Namen '" + needle + "' gefunden. Es wurde nichts ausgewählt."
                1 -> pending = FileAction("1 Datei löschen", exactMatches, delete = true)
                else -> result = "Der Dateiname '" + needle + "' kommt " + exactMatches.size + "-mal vor. Bitte wähle einen eindeutigeren Namen. Es wurde nichts ausgewählt."
            }
            return
        }

        val selected = when {
            needle.contains('.') && exactNamedFiles.size == 1 -> exactNamedFiles
            // Keep filename-like searches exact too; never broaden a missing or
            // ambiguous basename into a MIME category.
            needle.contains('.') -> emptyList()
            hasExplicitImageIntent -> files.filter { it.mime.startsWith("image/") }
            hasExplicitVideoIntent -> files.filter { it.mime.startsWith("video/") }
            hasExplicitAudioIntent -> files.filter { it.mime.startsWith("audio/") }
            hasExplicitGameIntent -> files.filter { it.name.endsWith(".apk", true) || it.name.contains("game", true) }
            else -> files.filter { it.name.contains(needle.ifBlank { q }, true) }
        }
        when {
            hasExplicitDuplicateIntent -> {
                scope.launch {
                    busy = true
                    val groups = withContext(Dispatchers.IO) { findDuplicates(context, files) }
                    val duplicates = groups.flatMap { it.drop(1) }
                    result = if (duplicates.isEmpty()) "Keine inhaltlich identischen Dateien gefunden." else "${duplicates.size} Duplikate in ${groups.size} Gruppen gefunden: " + duplicates.take(8).joinToString { it.name }
                    if (q.contains("lösch") || q.contains("entfern") || q.contains("delete")) {
                        pending = if (duplicates.isEmpty()) null else FileAction("${duplicates.size} erkannte Duplikate löschen", duplicates, delete = true)
                    }
                    busy = false
                }
            }
            q.contains("sortier") || q.contains("ordne") || q.contains("verschieb") -> {
                val category = when {
                    selected.all { it.mime.startsWith("image/") } -> "Bilder"
                    selected.all { it.mime.startsWith("video/") } -> "Videos"
                    selected.all { it.mime.startsWith("audio/") } -> "Audio"
                    q.contains("spiel") || q.contains("game") || q.contains("apk") -> "Spiele"
                    else -> "Sortiert"
                }
                if (selected.isEmpty()) result = "Keine passenden Dateien gefunden."
                else pending = FileAction("${selected.size} Dateien nach '$category' verschieben", selected, category)
            }
            q.contains("lösch") || q.contains("entfern") || q.contains("delete") -> {
                if (selected.isEmpty()) result = "Keine passenden Dateien gefunden."
                else pending = FileAction("${selected.size} Dateien löschen", selected, delete = true)
            }
            q.startsWith("zeige") || q.startsWith("finde") || q.startsWith("suche") -> {
                result = "${selected.size} passende Dateien: " + selected.take(12).joinToString { it.name }
            }
            else -> result = "Befehl nicht eindeutig. Beispiele: „Finde Duplikate“, „Sortiere Bilder“, „Zeige Videos“, „Lösche Urlaub.jpg“."
        }
    }

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Telefon-Dateimanager")
        Text("Chatgesteuerte Dateiverwaltung · Android-Speicherfreigabe")
        Text("Speicherrechte: $accessStatus")
        Text("Android 10+ erlaubt aus Sicherheitsgründen keinen stillen Vollzugriff auf den gesamten Gerätespeicher. Wähle im Systemdialog einen Ordner; die Freigabe gilt dauerhaft für diesen Ordner und seine Unterordner, bis du sie in Android widerrufst.")
        Text("Wichtig: „Spiele“ findet nur APK-Dateien bzw. entsprechend benannte Dateien im freigegebenen Ordner. Bereits installierte Apps lassen sich hier aus Sicherheitsgründen weder verschieben noch deinstallieren.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { picker.launch(treeUri) }) { Text(if (treeUri == null) "Speicherzugriff erlauben" else "Ordner / Rechte ändern") }
            OutlinedButton(onClick = { refresh() }, enabled = treeUri != null && !busy) { Text("Aktualisieren") }
            if (treeUri != null) OutlinedButton(onClick = {
                treeUri?.let { uri -> runCatching { context.contentResolver.releasePersistableUriPermission(uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION) } }
                treeUri = null
                prefs.edit().remove("tree").apply()
                files = emptyList()
                accessStatus = "Nicht freigegeben"
                result = "Speicherzugriff wurde in der App zurückgesetzt."
            }) { Text("Trennen") }
        }
        OutlinedTextField(
            value = command, onValueChange = { command = it }, modifier = Modifier.fillMaxWidth(),
            label = { Text("Was soll ich mit deinen Dateien tun?") },
            placeholder = { Text("z. B. Finde Duplikate oder sortiere Bilder") },
            trailingIcon = { androidx.compose.material3.Icon(Icons.Default.Search, contentDescription = null) }
        )
        Button(onClick = { plan(command) }, enabled = treeUri != null && !busy) { Text("Befehl ausführen") }
        Text(if (busy) "Arbeite …" else result)
        Text("Dateien: ${files.size}")
        LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(files.take(150), key = { it.id }) { file ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(10.dp)) {
                        Text(file.name)
                        Text("${file.mime} · ${file.size} Bytes")
                    }
                }
            }
        }
    }

    pending?.let { action ->
        AlertDialog(
            onDismissRequest = { pending = null },
            title = { Text(action.title) },
            text = { Column { Text("Bitte prüfe die betroffenen Dateien. Es wird nichts ohne deine Bestätigung geändert. Hinweis: Löschen kann endgültig sein und ist nicht über die App rückgängig zu machen."); action.files.take(12).forEach { Text("• ${it.name}") }; if (action.files.size > 12) Text("… und ${action.files.size - 12} weitere") } },
            confirmButton = {
                TextButton(onClick = {
                    pending = null
                    scope.launch {
                        busy = true
                        try {
                            val selectedTree = treeUri
                            val grant = selectedTree?.let { uri -> context.contentResolver.persistedUriPermissions.firstOrNull { it.uri == uri } }
                            if (grant?.isWritePermission != true) {
                                result = "Schreibzugriff fehlt. Bitte den Ordner erneut auswählen und Lesen/Schreiben erlauben."
                                busy = false
                                return@launch
                            }
                            val changed = withContext(Dispatchers.IO) {
                                if (action.delete) action.files.count { runCatching { DocumentsContract.deleteDocument(resolver, it.uri) }.getOrDefault(false) }
                                else if (action.folder != null && selectedTree != null) moveIntoFolder(context, selectedTree, action.files, action.folder)
                                else 0
                            }
                            result = "$changed Dateien verarbeitet."
                            refresh()
                        } catch (e: Exception) { result = "Aktion fehlgeschlagen: ${e.message}" }
                        busy = false
                    }
                }) { Text("Bestätigen") }
            },
            dismissButton = { TextButton(onClick = { pending = null }) { Text("Abbrechen") } }
        )
    }
}

private fun listFiles(context: Context, tree: Uri): List<PhoneFile> {
    val resolver = context.contentResolver
    val rootId = DocumentsContract.getTreeDocumentId(tree)
    val queue = ArrayDeque<Pair<String, Int>>()
    val visited = mutableSetOf<String>()
    val out = mutableListOf<PhoneFile>()
    queue.add(rootId to 0)
    while (queue.isNotEmpty() && out.size < 5000) {
        val (parentId, depth) = queue.removeFirst()
        if (!visited.add(parentId) || depth > 12) continue
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
        resolver.query(children, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE), null, null, null)?.use { c ->
            val idCol = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
            val nameCol = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
            val mimeCol = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
            val sizeCol = c.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE)
            while (c.moveToNext() && out.size < 5000) {
                val id = c.getString(idCol)
                val name = c.getString(nameCol) ?: id
                val mime = c.getString(mimeCol) ?: "application/octet-stream"
                if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                    queue.add(id to depth + 1)
                } else {
                    val uri = DocumentsContract.buildDocumentUriUsingTree(tree, id)
                    out += PhoneFile(uri, id, parentId, name, mime, if (sizeCol >= 0 && !c.isNull(sizeCol)) c.getLong(sizeCol) else 0L)
                }
            }
        }
    }
    return out.sortedBy { it.name.lowercase() }
}

private fun findDuplicates(context: Context, files: List<PhoneFile>): List<List<PhoneFile>> {
    val buckets = files.filter { it.size > 0 }.groupBy { it.size }.values.filter { it.size > 1 }
    val groups = mutableListOf<List<PhoneFile>>()
    for (bucket in buckets) {
        val hashes = bucket.mapNotNull { file ->
            runCatching {
                val digest = MessageDigest.getInstance("SHA-256")
                context.contentResolver.openInputStream(file.uri)?.use { input ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }
                } ?: return@runCatching null
                digest.digest().joinToString("") { "%02x".format(it) } to file
            }.getOrNull()
        }.groupBy({ it.first }, { it.second }).values.filter { it.size > 1 }
        groups += hashes
    }
    return groups
}

private fun moveIntoFolder(context: Context, tree: Uri, files: List<PhoneFile>, folder: String): Int {
    val resolver = context.contentResolver
    val rootId = DocumentsContract.getTreeDocumentId(tree)
    val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, rootId)
    var folderId: String? = null
    resolver.query(childrenUri, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE), null, null, null)?.use { c ->
        val id = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
        val name = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
        val mime = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
        while (c.moveToNext()) if (c.getString(name) == folder && c.getString(mime) == DocumentsContract.Document.MIME_TYPE_DIR) folderId = c.getString(id)
    }
    if (folderId == null) {
        val created = DocumentsContract.createDocument(resolver, DocumentsContract.buildDocumentUriUsingTree(tree, rootId), DocumentsContract.Document.MIME_TYPE_DIR, folder) ?: return 0
        folderId = DocumentsContract.getDocumentId(created)
    }
    val target = DocumentsContract.buildDocumentUriUsingTree(tree, folderId!!)
    var moved = 0
    for (file in files) {
        val parent = DocumentsContract.buildDocumentUriUsingTree(tree, file.parentId)
        if (runCatching { DocumentsContract.moveDocument(resolver, file.uri, parent, target) }.getOrNull() != null) moved++
    }
    return moved
}
