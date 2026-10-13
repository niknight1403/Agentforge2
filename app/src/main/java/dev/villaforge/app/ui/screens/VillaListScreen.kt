package dev.villaforge.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import dev.villaforge.app.ui.UiState
import dev.villaforge.app.ui.components.EmptyState
import dev.villaforge.app.ui.components.SkeletonList
import dev.villaforge.app.ui.theme.Aqua

/*
 * Villen-Liste (v1.14.0): Shimmer-Skelett waehrend des Ladens, EmptyState
 * mit Handlungsaufforderung statt nackter Zeile.
 */
@Composable
fun VillaListScreen(state: UiState, onOpen: (Long) -> Unit) {
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        state.error?.let { ErrorBanner(it) }
        if (state.message.isNotBlank()) Text(state.message, color = Aqua, style = muted())

        when {
            state.villas.isEmpty() && !state.online -> SkeletonList(rows = 4)
            state.villas.isEmpty() -> EmptyState(
                title = "Noch keine Villa",
                hint = "Tippe unten auf „Deep Agent“ und gib eine Idee ein — der Rest passiert autonom."
            )
            else -> {
                Spacer(Modifier.height(10.dp))
                LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(state.villas, key = { it.id }) { villa ->
                        Card(villa.name, villa.idea.take(120), villa.status) {
                            OutlinedButton(onClick = { onOpen(villa.id) }) { Text("Öffnen") }
                        }
                    }
                }
            }
        }
    }
}
