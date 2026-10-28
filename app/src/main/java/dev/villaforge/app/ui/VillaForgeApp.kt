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
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.HealthAndSafety
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import dev.villaforge.app.ui.components.auroraBg
import androidx.compose.ui.graphics.Color
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
import dev.villaforge.app.ui.screens.CapabilitiesScreen
import dev.villaforge.app.ui.screens.ChatScreen
import dev.villaforge.app.ui.screens.CreateVillaScreen
import dev.villaforge.app.ui.screens.DevScreen
import dev.villaforge.app.ui.screens.DeepAgentScreen
import dev.villaforge.app.ui.screens.DeepChatScreen
import dev.villaforge.app.ui.screens.DashboardScreen
import dev.villaforge.app.ui.screens.DiagnosticsScreen
import dev.villaforge.app.ui.screens.DetailScreen
import dev.villaforge.app.ui.screens.LiveDot
import dev.villaforge.app.ui.screens.LoginScreen
import dev.villaforge.app.ui.screens.MasterScreen
import dev.villaforge.app.ui.screens.SettingsScreen
import dev.villaforge.app.ui.screens.VillaListScreen
import dev.villaforge.app.ui.screens.muted
import dev.villaforge.app.ui.theme.Aqua
import dev.villaforge.app.ui.theme.NeonCyan
import dev.villaforge.app.ui.theme.Ink
import dev.villaforge.app.ui.theme.Surface1
import dev.villaforge.app.ui.theme.TextMain
import dev.villaforge.app.ui.theme.TextMuted

/*
 * App-Schale (v1.14.0): Der 1.026-Zeilen-Monolith wurde aufgeteilt — Screens
 * leben in ui/screens/, Bausteine in ui/components/, der Parser in core/.
 * Hier bleibt nur die Navigation mit sanften uebergangen zurueck.
 */
private enum class Screen { LIST, CREATE, DASHBOARD, DETAIL, CHAT, MASTER, DEV, DEEP, DEEP_CHAT, SETTINGS, DIAGNOSTICS, CAPABILITIES }

private val topLevelScreens = listOf(Screen.LIST, Screen.DASHBOARD, Screen.MASTER, Screen.DIAGNOSTICS, Screen.SETTINGS, Screen.CAPABILITIES)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VillaForgeApp(viewModel: MainViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var screen by remember { mutableStateOf(Screen.DASHBOARD) }
    var masterPrompt by remember { mutableStateOf("") }

    /* Quality-Layer v2: EIN zentraler Aurora-Hintergrund auf App-Ebene. */
    Box(Modifier.fillMaxSize().auroraBg()) {
        Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            if (screen != Screen.DASHBOARD) TopAppBar(
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
                    if (!topLevelScreens.contains(screen)) {
                        IconButton(onClick = {
                            when (screen) {
                                Screen.CHAT, Screen.DEV -> screen = Screen.DETAIL
                                else -> { screen = Screen.LIST; viewModel.closeDetail() }
                            }
                        }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Zurück") }
                    }
                },
                actions = {
                    if (topLevelScreens.contains(screen)) {
                        IconButton(onClick = { viewModel.refreshAll() }) {
                            Icon(Icons.Filled.Refresh, contentDescription = "Aktualisieren")
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.Transparent,
                    titleContentColor = TextMain,
                    navigationIconContentColor = NeonCyan,
                    actionIconContentColor = TextMain
                )
            )
        },
        bottomBar = {
            if (topLevelScreens.contains(screen)) {
                NavigationBar(containerColor = Color.Transparent, tonalElevation = 0.dp) {
                    NavigationBarItem(selected = screen == Screen.DASHBOARD, onClick = { viewModel.closeDetail(); screen = Screen.DASHBOARD },
                        icon = { Icon(Icons.Filled.Dashboard, contentDescription = "Übersicht", tint = if (screen == Screen.DASHBOARD) NeonCyan else TextMuted) },
                        label = { Text("Übersicht") })
                    NavigationBarItem(selected = screen == Screen.MASTER, onClick = { viewModel.closeDetail(); screen = Screen.MASTER },
                        icon = { Icon(Icons.Filled.AutoAwesome, contentDescription = "Master-Agent", tint = if (screen == Screen.MASTER) NeonCyan else TextMuted) },
                        label = { Text("Master") })
                    NavigationBarItem(selected = screen == Screen.LIST, onClick = { viewModel.closeDetail(); screen = Screen.LIST },
                        icon = { Icon(Icons.Filled.Home, contentDescription = "Villen", tint = if (screen == Screen.LIST) NeonCyan else TextMuted) },
                        label = { Text("Villen") })
                    NavigationBarItem(selected = screen == Screen.CAPABILITIES, onClick = { viewModel.closeDetail(); screen = Screen.CAPABILITIES },
                        icon = { Icon(Icons.Filled.Build, contentDescription = "Werkzeuge", tint = if (screen == Screen.CAPABILITIES) NeonCyan else TextMuted) },
                        label = { Text("Werkzeuge") })
                }
            }
        },
        floatingActionButton = {
            if (screen == Screen.LIST) {
                Button(onClick = { screen = Screen.CREATE }, shape = RoundedCornerShape(16.dp)) {
                    Icon(Icons.Filled.Add, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("Neue Villa")
                }
            }
        }
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (state.needsLogin) {
                LoginScreen(state, viewModel)
            } else AnimatedContent(
                targetState = screen,
                transitionSpec = {
                    (slideInHorizontally(initialOffsetX = { it / 6 }) + fadeIn()) togetherWith
                        (slideOutHorizontally(targetOffsetX = { -it / 6 }) + fadeOut())
                },
                label = "screenTransition"
            ) { target ->
                when (target) {
                    Screen.LIST -> VillaListScreen(state, viewModel) { id ->
                        viewModel.openVilla(id)
                        screen = Screen.DETAIL
                    }
                    Screen.DASHBOARD -> DashboardScreen(
                        state, viewModel,
                        onOpen = { id -> viewModel.openVilla(id); screen = Screen.DETAIL },
                        onBack = { screen = Screen.LIST },
                        onChat = { screen = Screen.MASTER },
                        onVillas = { viewModel.closeDetail(); screen = Screen.LIST },
                        onDiagnostics = { screen = Screen.DIAGNOSTICS },
                        onSettings = { screen = Screen.SETTINGS },
                        onSuperagent = { screen = Screen.MASTER },
                        onDeepAgent = { screen = Screen.DEEP },
                        onCapabilities = { screen = Screen.CAPABILITIES }
                    )
                    Screen.MASTER -> MasterScreen(state, viewModel, masterPrompt) { masterPrompt = "" }
                    Screen.CREATE -> CreateVillaScreen(state, viewModel) { id ->
                        viewModel.openVilla(id)
                        screen = Screen.CHAT
                    }
                    Screen.DETAIL -> DetailScreen(state, viewModel, onChat = { screen = Screen.CHAT }, onDeleted = { screen = Screen.LIST }, onDev = { screen = Screen.DEV })
                    Screen.CHAT -> ChatScreen(state, viewModel)
                    Screen.DEV -> DevScreen(state, viewModel, onOpenVilla = { id -> viewModel.openVilla(id); screen = Screen.DEV })
                    Screen.DEEP -> DeepAgentScreen(state, viewModel, onOpenProject = { id -> viewModel.openDeepProject(id); screen = Screen.DEEP_CHAT }, onBack = { screen = Screen.DASHBOARD })
                    Screen.DEEP_CHAT -> DeepChatScreen(
                        state,
                        viewModel,
                        onBack = { screen = Screen.DEEP },
                        onOpenVilla = { id -> viewModel.openVilla(id); screen = Screen.DEV }
                    )
                    Screen.SETTINGS -> SettingsScreen(state, viewModel) { screen = Screen.CAPABILITIES }
                    Screen.CAPABILITIES -> CapabilitiesScreen(state, viewModel) { prompt -> masterPrompt = prompt; screen = Screen.MASTER }
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

}
