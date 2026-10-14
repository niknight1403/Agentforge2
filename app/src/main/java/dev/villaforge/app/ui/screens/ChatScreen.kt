package dev.villaforge.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Button
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.villaforge.app.core.TextBlock
import dev.villaforge.app.core.parseTextBlocks
import dev.villaforge.app.net.ChatMessage
import dev.villaforge.app.ui.MainViewModel
import dev.villaforge.app.ui.UiState
import dev.villaforge.app.ui.theme.Aqua
import dev.villaforge.app.ui.theme.Surface1
import dev.villaforge.app.ui.theme.Surface2
import dev.villaforge.app.ui.theme.TextMain
import dev.villaforge.app.ui.theme.TextMuted
import dev.villaforge.app.ui.theme.Violet

/* Chat (v1.14.0): Blasen, Rich-Text-Parser aus der Core-Ebene. */
@Composable
fun ChatScreen(state: UiState, viewModel: MainViewModel) {
    var input by remember { mutableStateOf("") }
    var search by remember { mutableStateOf("") }
    val listState = rememberLazyListState()

    /* Sprint 12: Verlauf lokal durchsuchen (Trefferzaehler inklusive). */
    val shownMessages = if (search.isBlank()) state.messages
        else state.messages.filter { it.content.contains(search, ignoreCase = true) }

    // Ans Ende springen, sobald neue Nachrichten eintreffen.
    LaunchedEffect(state.messages.size) {
        if (state.messages.isNotEmpty()) listState.animateScrollToItem(state.messages.lastIndex)
    }

    Column(
        Modifier
            .fillMaxSize()
            .imePadding()
    ) {
        state.error?.let { ErrorBanner(it) }
        if (state.message.isNotBlank()) {
            Text(
                state.message,
                color = Aqua,
                style = muted(),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)
            )
        }

        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            if (state.messages.isEmpty()) {
                item {
                    Text(
                        "Schreibe dem Deep Agent eine Nachricht. Er kennt den Stand der Villa und antwortet mit einem Plan.",
                        style = muted(),
                        color = TextMuted
                    )
                }
            }
            if (search.isNotBlank()) {
                item {
                    Text(
                        "${shownMessages.size} von ${state.messages.size} Nachrichten",
                        style = muted(), color = TextMuted
                    )
                }
            }
            items(shownMessages) { ChatBubble(it) }
            if (state.busy) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(6.dp)) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = Aqua)
                        Spacer(Modifier.width(8.dp))
                        Text("Deep Agent arbeitet …", style = muted(), color = TextMuted)
                    }
                }
            }
        }

        /* Sprint 11: Chat-Partner waehlen (Dropdown mit allen Agenten). */
        val detail = state.detail
        if (detail != null) {
            var menuOpen by remember { mutableStateOf(false) }
            val selected = detail.agents.firstOrNull { it.id == state.chatAgentId }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (detail.agents.size > 1) {
                    Text("An:", style = muted(), color = TextMuted)
                    Spacer(Modifier.width(6.dp))
                    Box {
                        OutlinedButton(onClick = { menuOpen = true }) {
                            Text(selected?.name ?: "Deep Agent", maxLines = 1)
                            Icon(Icons.Filled.ArrowDropDown, contentDescription = "Chat-Partner waehlen")
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            detail.agents.forEach { agent ->
                                DropdownMenuItem(
                                    text = { Text(agent.name + if (agent.isRoot) " · Root" else "") },
                                    onClick = { viewModel.selectChatAgent(agent.id); menuOpen = false }
                                )
                            }
                        }
                    }
                    Spacer(Modifier.width(8.dp))
                }
                OutlinedTextField(
                    value = search,
                    onValueChange = { search = it },
                    placeholder = { Text("Verlauf durchsuchen") },
                    singleLine = true,
                    modifier = Modifier.weight(1f)
                )
                Spacer(Modifier.width(8.dp))
                val shareContext = androidx.compose.ui.platform.LocalContext.current
                OutlinedButton(onClick = {
                    /* Sprint 23: gesamten Verlauf als Text teilen. */
                    val header = "Chat-Verlauf " +
                        (state.detail?.villa?.name?.let { n -> "– $n " } ?: "") +
                        time(System.currentTimeMillis()) + "\n\n"
                    val body = state.messages.joinToString("\n\n") { m ->
                        (if (m.role == "user") "Ich: " else "Agent: ") + m.content
                    }
                    val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(android.content.Intent.EXTRA_TEXT, header + body)
                    }
                    shareContext.startActivity(android.content.Intent.createChooser(send, "Chat-Verlauf teilen"))
                }) {
                    Icon(Icons.Filled.Share, contentDescription = "Chat-Verlauf teilen")
                }
            }
        }

        HorizontalDivider(color = Surface2)

        val villaId = state.detail?.villa?.id
        val lastEvent = state.events.firstOrNull { it.villaId == villaId }
        if (lastEvent != null) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(Surface2)
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                LiveDot(state.live)
                Spacer(Modifier.width(6.dp))
                Text(lastEvent.text, style = muted(), color = TextMuted, modifier = Modifier.weight(1f))
                Text(time(lastEvent.ts), style = muted(), color = TextMuted)
            }
        }

        Row(
            Modifier
                .fillMaxWidth()
                .background(Surface1)
                .padding(10.dp),
            verticalAlignment = Alignment.Bottom
        ) {
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                placeholder = { Text("Nachricht an " + (state.detail?.agents?.firstOrNull { it.id == state.chatAgentId }?.name ?: "den Deep Agent")) },
                modifier = Modifier.weight(1f),
                maxLines = 5
            )
            Spacer(Modifier.width(8.dp))
            val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current
            Button(
                onClick = {
                    if (input.isNotBlank()) {
                        haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                        viewModel.sendChat(input); input = ""
                    }
                },
                enabled = input.isNotBlank() && !state.busy,
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 14.dp)
            ) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Senden") }
        }
    }
}

@Composable
internal fun ChatBubble(message: ChatMessage) {
    val isUser = message.role == "user"
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start
    ) {
        Column(
            Modifier
                .then(if (isUser) Modifier.fillMaxWidth(0.86f) else Modifier.fillMaxWidth())
                .clip(RoundedCornerShape(14.dp))
                .background(if (isUser) Violet.copy(alpha = 0.22f) else Surface1)
                .padding(12.dp)
        ) {
            Text(
                if (isUser) "Du" else "Agent · " + time(message.createdAt),
                style = muted(),
                color = TextMuted,
                fontWeight = FontWeight.SemiBold
            )
            Spacer(Modifier.height(6.dp))
            if (isUser) Text(message.content, color = TextMain) else RichText(message.content)
            if (!isUser) {
                val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
                Spacer(Modifier.height(4.dp))
                TextButton(onClick = {
                    clipboard.setText(androidx.compose.ui.text.AnnotatedString(message.content))
                }) { Text("Kopieren") }
            }
        }
    }
}

/**
 * Stellt Agentenantworten uebersichtlich dar: "## "-Zeilen werden zu
 * Abschnittsueberschriften, "- "/"1. " bleiben als Listen erhalten.
 */
@Composable
internal fun RichText(text: String) {
    val blocks = remember(text) { parseTextBlocks(text) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        blocks.forEach { block ->
            when (block) {
                is TextBlock.Heading -> Text(
                    block.text,
                    fontWeight = FontWeight.Bold,
                    color = Aqua,
                    style = MaterialTheme.typography.titleMedium
                )
                is TextBlock.Bullet -> Row(Modifier.fillMaxWidth()) {
                    Text("•  ", color = Violet, fontWeight = FontWeight.Bold)
                    Text(block.text, modifier = Modifier.weight(1f))
                }
                is TextBlock.Numbered -> Row(Modifier.fillMaxWidth()) {
                    Text("${block.number}.  ", color = Violet, fontWeight = FontWeight.Bold)
                    Text(block.text, modifier = Modifier.weight(1f))
                }
                is TextBlock.Paragraph -> Text(block.text, color = TextMain)
            }
        }
    }
}
