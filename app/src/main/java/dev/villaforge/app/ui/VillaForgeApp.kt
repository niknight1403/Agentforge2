package dev.villaforge.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.HealthAndSafety
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.SmartToy
import dev.villaforge.app.ui.screens.MasterScreen
import androidx.compose.material3.TextButton
import dev.villaforge.app.ui.components.EmptyState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.villaforge.app.ui.screens.ChatScreen
import dev.villaforge.app.ui.screens.CreateVillaScreen
import dev.villaforge.app.ui.screens.DevScreen
import dev.villaforge.app.ui.screens.DashboardScreen
import dev.villaforge.app.ui.screens.DiagnosticsScreen
import dev.villaforge.app.ui.screens.DetailScreen
import dev.villaforge.app.ui.screens.LiveDot
import dev.villaforge.app.ui.screens.LoginScreen
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
private enum class Screen { LIST, CREATE, DASHBOARD, DETAIL, CHAT, MASTER, DEV, SETTINGS, DIAGNOSTICS }

private val topLevelScreens = listOf(Screen.LIST, Screen.DASHBOARD, Screen.CHAT, Screen.MASTER, Screen.DIAGNOSTICS, Screen.SETTINGS)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VillaForgeApp(viewModel: MainViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var screen by rememberSaveable { mutableStateOf(Screen.DASHBOARD) }

    val openChat: () -> Unit = { screen = Screen.MASTER }
    LaunchedEffect(screen, state.selectedVillaId, state.detail) {
        if (screen in listOf(Screen.DETAIL, Screen.CHAT, Screen.DEV) &&
            state.selectedVillaId == null && state.detail == null) screen = Screen.LIST
    }
    val goBack: () -> Unit = {
        when (screen) {
            Screen.CHAT, Screen.DEV -> screen = Screen.DETAIL
            else -> { screen = Screen.LIST; viewModel.closeDetail() }
        }
    }
    BackHandler(enabled = screen != Screen.LIST && !state.needsLogin, onBack = goBack)
    val destinations = listOf(
        Triple(Screen.LIST, Icons.Filled.Home, "Villen"),
        Triple(Screen.DASHBOARD, Icons.Filled.Dashboard, "Übersicht"),
        Triple(Screen.MASTER, Icons.Filled.SmartToy, "Master"),
        Triple(Screen.DIAGNOSTICS, Icons.Filled.HealthAndSafety, "Diagnose"),
        Triple(Screen.SETTINGS, Icons.Filled.Settings, "System")
    )
    val title = when (screen) {
        Screen.LIST -> "VillaForge"
        Screen.CREATE -> "Neue Villa"
        Screen.DASHBOARD -> "Mission Control"
        Screen.DETAIL -> "Entwicklungsraum"
        Screen.CHAT -> "Deep Agent"
        Screen.MASTER -> "Master-Agent"
        Screen.DEV -> "Entwicklung"
        Screen.SETTINGS -> "Einstellungen"
        Screen.DIAGNOSTICS -> "Systemdiagnose"
    }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val useRail = maxWidth >= 840.dp && topLevelScreens.contains(screen) && !state.needsLogin
        Row(Modifier.fillMaxSize()) {
            if (useRail) {
                NavigationRail(containerColor = Surface1, modifier = Modifier.fillMaxHeight()) {
                    destinations.forEach { (target, icon, label) ->
                        NavigationRailItem(
                            selected = screen == target,
                            onClick = {
                                if (target == Screen.CHAT) openChat()
                                else { viewModel.closeDetail(); screen = target }
                            },
                            icon = { Icon(icon, contentDescription = null) },
                            label = { Text(label) }
                        )
                    }
                }
            }
            Scaffold(
                modifier = Modifier.weight(1f),
                containerColor = Ink,
                topBar = {
                    TopAppBar(
                        title = {
                            Column {
                                Text(if (state.needsLogin) "Mit Hub verbinden" else title, style = MaterialTheme.typography.titleLarge)
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(state.healthText, style = muted(), color = TextMuted)
                                    Spacer(Modifier.width(6.dp))
                                    LiveDot(state.live)
                                }
                            }
                        },
                        navigationIcon = {
                            if (screen != Screen.LIST && !state.needsLogin) {
                                IconButton(onClick = goBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Zurück") }
                            }
                        },
                        actions = {
                            if (topLevelScreens.contains(screen) && !state.needsLogin) {
                                IconButton(onClick = { viewModel.refreshAll() }) {
                                    Icon(Icons.Filled.Refresh, contentDescription = "Aktualisieren")
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
                bottomBar = {
                    if (topLevelScreens.contains(screen) && !useRail && !state.needsLogin) {
                        NavigationBar(containerColor = Surface1) {
                            destinations.forEach { (target, icon, label) ->
                                NavigationBarItem(
                                    selected = screen == target,
                                    onClick = {
                                if (target == Screen.CHAT) openChat()
                                else { viewModel.closeDetail(); screen = target }
                            },
                                    icon = { Icon(icon, contentDescription = null) },
                                    label = { Text(label) }
                                )
                            }
                        }
                    }
                },
                floatingActionButton = {
                    if (screen == Screen.LIST && !state.needsLogin) {
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
                    } else if (screen in listOf(Screen.DETAIL, Screen.CHAT, Screen.DEV) && state.detail == null) {
                        Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            EmptyState(
                                title = if (state.villaLoading) "Projekt wird geladen" else "Projekt konnte nicht geladen werden",
                                hint = state.error ?: "Der gespeicherte Entwicklungsraum wird vom Hub geladen."
                            )
                            if (!state.villaLoading) TextButton(onClick = { viewModel.retrySelectedVilla() }) { Text("Erneut versuchen") }
                            TextButton(onClick = { viewModel.closeDetail(); screen = Screen.LIST }) { Text("Zu den Villen") }
                        }
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
                                onBack = { screen = Screen.LIST }, onChat = openChat,
                                onVillas = { viewModel.closeDetail(); screen = Screen.LIST },
                                onDiagnostics = { screen = Screen.DIAGNOSTICS },
                                onSettings = { screen = Screen.SETTINGS },
                                onSuperagent = {
                                    val target = state.villas.firstOrNull { it.status == "RUNNING" } ?: state.villas.firstOrNull()
                                    if (target != null) { viewModel.openVilla(target.id); screen = Screen.DEV }
                                    else screen = Screen.CREATE
                                }
                            )
                            Screen.CREATE -> CreateVillaScreen(state, viewModel) { id ->
                                viewModel.openVilla(id)
                                screen = Screen.CHAT
                            }
                            Screen.DETAIL -> DetailScreen(state, viewModel, onChat = { screen = Screen.CHAT }, onDeleted = { screen = Screen.LIST }, onDev = { screen = Screen.DEV })
                            Screen.CHAT -> ChatScreen(state, viewModel)
                            Screen.MASTER -> MasterScreen(state, viewModel)
                            Screen.DEV -> DevScreen(state, viewModel, onOpenVilla = { id -> viewModel.openVilla(id); screen = Screen.DEV })
                            Screen.SETTINGS -> SettingsScreen(state, viewModel)
                            Screen.DIAGNOSTICS -> DiagnosticsScreen(state, viewModel)
                        }
                    }

                    if (state.busy) {
                        LinearProgressIndicator(
                            modifier = Modifier.align(Alignment.TopCenter).fillMaxWidth(),
                            color = Aqua,
                            trackColor = Surface1
                        )
                    }
                }
            }
        }
    }
}
