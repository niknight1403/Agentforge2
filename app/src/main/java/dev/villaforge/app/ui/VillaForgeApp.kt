package dev.villaforge.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.HealthAndSafety
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.villaforge.app.ui.screens.ChatScreen
import dev.villaforge.app.ui.screens.CreateVillaScreen
import dev.villaforge.app.ui.screens.DashboardScreen
import dev.villaforge.app.ui.screens.DiagnosticsScreen
import dev.villaforge.app.ui.screens.DetailScreen
import dev.villaforge.app.ui.screens.LiveDot
import dev.villaforge.app.ui.screens.SettingsScreen
import dev.villaforge.app.ui.screens.VillaListScreen
import dev.villaforge.app.ui.screens.muted
import dev.villaforge.app.ui.theme.Aqua
import dev.villaforge.app.ui.theme.Ink
import dev.villaforge.app.ui.theme.Surface1
import dev.villaforge.app.ui.theme.TextMain
import dev.villaforge.app.ui.theme.TextMuted

/*
 * App-Schale (v1.14.0): Der 1.026-Zeilen-Monolith wurde aufgeteilt — Screens
 * leben in ui/screens/, Bausteine in ui/components/, der Parser in core/.
 * Hier bleibt nur die Navigation mit sanften uebergangen zurueck.
 */
private enum class Screen { LIST, CREATE, DASHBOARD, DETAIL, CHAT, SETTINGS, DIAGNOSTICS }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VillaForgeApp(viewModel: MainViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var screen by remember { mutableStateOf(Screen.LIST) }

    Scaffold(
        containerColor = Ink,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("VillaForge", fontWeight = FontWeight.Bold)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(state.healthText, style = muted(), color = TextMuted)
                            Spacer(Modifier.width(6.dp))
                            LiveDot(state.live)
                        }
                    }
                },
                navigationIcon = {
                    if (screen != Screen.LIST) {
                        IconButton(onClick = {
                            when (screen) {
                                Screen.CHAT -> screen = Screen.DETAIL
                                else -> { screen = Screen.LIST; viewModel.closeDetail() }
                            }
                        }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Zurück") }
                    }
                },
                actions = {
                    if (screen == Screen.LIST) {
                        IconButton(onClick = { screen = Screen.DASHBOARD }) {
                            Icon(Icons.Filled.Dashboard, contentDescription = "Dashboard")
                        }
                        IconButton(onClick = { screen = Screen.DIAGNOSTICS }) {
                            Icon(Icons.Filled.HealthAndSafety, contentDescription = "Diagnose")
                        }
                        IconButton(onClick = { viewModel.refreshAll() }) {
                            Icon(Icons.Filled.Refresh, contentDescription = "Aktualisieren")
                        }
                        IconButton(onClick = { screen = Screen.SETTINGS }) {
                            Icon(Icons.Filled.Settings, contentDescription = "Einstellungen")
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Surface1,
                    titleContentColor = TextMain,
                    navigationIconContentColor = TextMain,
                    actionIconContentColor = TextMain
                )
            )
        },
        floatingActionButton = {
            if (screen == Screen.LIST) {
                Button(onClick = { screen = Screen.CREATE }, shape = RoundedCornerShape(16.dp)) {
                    Icon(Icons.Filled.Add, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("Deep Agent")
                }
            }
        }
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            AnimatedContent(
                targetState = screen,
                transitionSpec = {
                    (slideInHorizontally(initialOffsetX = { it / 6 }) + fadeIn()) togetherWith
                        (slideOutHorizontally(targetOffsetX = { -it / 6 }) + fadeOut())
                },
                label = "screenTransition"
            ) { target ->
                when (target) {
                    Screen.LIST -> VillaListScreen(state) { id ->
                        viewModel.openVilla(id)
                        screen = Screen.DETAIL
                    }
                    Screen.DASHBOARD -> DashboardScreen(state, viewModel) { screen = Screen.LIST }
                    Screen.CREATE -> CreateVillaScreen(state, viewModel) { id ->
                        viewModel.openVilla(id)
                        screen = Screen.CHAT
                    }
                    Screen.DETAIL -> DetailScreen(state, viewModel, onChat = { screen = Screen.CHAT }, onDeleted = { screen = Screen.LIST })
                    Screen.CHAT -> ChatScreen(state, viewModel)
                    Screen.SETTINGS -> SettingsScreen(state, viewModel)
                    Screen.DIAGNOSTICS -> DiagnosticsScreen(state, viewModel)
                }
            }

            if (state.busy) {
                CircularProgressIndicator(
                    modifier = Modifier.align(Alignment.TopCenter).padding(top = 8.dp).size(32.dp),
                    color = Aqua
                )
            }
        }
    }
}
