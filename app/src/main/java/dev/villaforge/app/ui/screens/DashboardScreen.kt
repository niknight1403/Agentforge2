package dev.villaforge.app.ui.screens

import dev.villaforge.app.ui.components.AuroraBackground
import dev.villaforge.app.ui.components.GoldChip
import dev.villaforge.app.ui.theme.Gold
import dev.villaforge.app.ui.theme.GoldGradient
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.HealthAndSafety
import androidx.compose.material.icons.filled.LocalFireDepartment
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.villaforge.app.ui.MainViewModel
import dev.villaforge.app.ui.UiState
import dev.villaforge.app.ui.components.GlassCard
import dev.villaforge.app.ui.components.MetricChip
import dev.villaforge.app.ui.components.NeonChip
import dev.villaforge.app.ui.components.NeonIconPlate
import dev.villaforge.app.ui.components.NeonRing
import dev.villaforge.app.ui.components.SparkLine
import dev.villaforge.app.ui.theme.Aqua
import dev.villaforge.app.ui.theme.Danger
import dev.villaforge.app.ui.theme.ElectricBlue
import dev.villaforge.app.ui.theme.NeonCyan
import dev.villaforge.app.ui.theme.NeonGradient
import dev.villaforge.app.ui.theme.NeonPink
import dev.villaforge.app.ui.theme.TextMuted
import dev.villaforge.app.ui.theme.TextMain
import dev.villaforge.app.ui.theme.Success

/*
 * Uebersicht (v1.31.0, Cyber-Neon-Redesign): Empfangs-Dashboard im
 * Control-Center-Look — Kopfzeile mit Logo und Glocke, Profil-Sektion,
 * Kennzahlen-Chips, drei Einstiegskarten (Systemstatus, KI-Chat, Villen),
 * Aktivitaetskarte mit Sparkline und der Superagent-Banner.
 */
@Composable
fun DashboardScreen(
    state: UiState,
    viewModel: MainViewModel,
    onOpen: (Long) -> Unit,
    onBack: () -> Unit,
    onChat: () -> Unit = {},
    onVillas: () -> Unit = {},
    onDiagnostics: () -> Unit = {},
    onSettings: () -> Unit = {},
    onSuperagent: () -> Unit = {},
    onDeepAgent: () -> Unit = {}
) {
    val s = state.stats
    val agents = s?.optInt("agents") ?: 0
    val providers = state.routes.count { it.enabled }
    val open = s?.optJSONObject("tasks")?.optInt("open") ?: 0
    val done = s?.optJSONObject("tasks")?.optInt("done", 0) ?: 0
    val messages = s?.optInt("messages") ?: 0
    val running = state.villas.count { it.executing }
    val waiting = state.villas.count { it.queued }
    val uptimeHours = (s?.optLong("uptimeSec", 0L) ?: 0L) / 3600
    val llmState = s?.optJSONObject("llm")?.optString("state", "unverified") ?: "unverified"
    val modelLabel = when (llmState) { "recently_verified" -> "Geprüft"; "unavailable" -> "Nicht bereit"; else -> "Ungeprüft" }
    val maturityScores = mutableListOf<Float>()
    val maturity = s?.optJSONArray("maturity")
    val villaMaturity = mutableListOf<Triple<String, Int, String>>() // Name, Score, Phase
    if (maturity != null) {
        (0 until maturity.length()).forEach { i ->
            val m = maturity.optJSONObject(i) ?: return@forEach
            val rawScore = m.optInt("score", 0).coerceIn(0, 100)
            val verified = m.optBoolean("verified", false)
            val score = if (verified) rawScore else rawScore.coerceAtMost(95)
            maturityScores.add(score.toFloat())
            villaMaturity.add(Triple(m.optString("name", "?"), score, m.optString("currentPhase", m.optString("phase", "—")) + if (verified) " · geprüft" else " · Abnahme offen"))
        }
    }
    val topVillas = villaMaturity.sortedByDescending { it.second }.take(3)
    val profileName = viewModel.loggedInEmail.substringBefore('@').replaceFirstChar { it.uppercase() }.ifBlank { "Chef" }
    val activeRoute = s?.optJSONObject("llm")?.optString("lastSuccessfulRoute")?.takeIf { it.isNotBlank() } ?: "Noch keine bestätigte Modellantwort"

    /* Quality-Layer v2: Premium-Aurora-Hintergrund hinter dem Dashboard. */
    Box(Modifier.fillMaxSize()) {
        AuroraBackground(Modifier.fillMaxSize())
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
        state.error?.let { ErrorBanner(it) }

        /* ---- Kopfzeile: Logo links, Benachrichtigungs-Glocke rechts ---- */
        Row(verticalAlignment = Alignment.CenterVertically) {
            NeonIconPlate(icon = { Icon(Icons.Filled.LocalFireDepartment, null, tint = NeonCyan, modifier = Modifier.size(22.dp)) }, accent = NeonCyan, size = 38.dp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text("VillaForge", fontWeight = FontWeight.ExtraBold, fontSize = 20.sp, color = TextMain)
                Text("CONTROL CENTER", style = MaterialTheme.typography.labelSmall, color = TextMuted, letterSpacing = 2.sp)
                Spacer(Modifier.height(4.dp))
                GoldChip("ELITE · UNLIMITED")
            }
            Box(
                Modifier
                    .size(38.dp)
                    .clip(CircleShape)
                    .background(Color(0x14FFFFFF))
                    .border(1.dp, if (state.error == null) NeonCyan.copy(alpha = 0.6f) else Danger.copy(alpha = 0.8f), CircleShape)
                    .clickable { onDiagnostics() },
                contentAlignment = Alignment.Center
            ) {
                Icon(Icons.Filled.Notifications, "Benachrichtigungen", tint = if (state.error == null) NeonCyan else Danger, modifier = Modifier.size(19.dp))
            }
        }

        /* ---- Profil: Avatar mit Neon-Ring, Begruessung, Status ---- */
        GlassCard(accent = NeonCyan) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(62.dp).clip(CircleShape).border(2.dp, GoldGradient, CircleShape).padding(3.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Box(
                        Modifier.size(56.dp).clip(CircleShape).background(Color(0xFF172342)),
                        contentAlignment = Alignment.Center
                    ) { Icon(Icons.Filled.Person, null, tint = NeonCyan, modifier = Modifier.size(30.dp)) }
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text("Willkommen zurück,", style = MaterialTheme.typography.bodySmall, color = TextMuted)
                    Text(profileName, fontWeight = FontWeight.Bold, fontSize = 18.sp, color = TextMain)
                    Spacer(Modifier.height(5.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        NeonChip("Administrator", NeonCyan)
                        NeonChip(if (state.online) "Online" else "Offline", if (state.online) Success else Danger)
                    }
                }
                TextButton(onClick = onSettings) { Text("Profil ›") }
            }
        }

        /* ---- Kennzahlen-Chips ---- */
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            MetricChip("$agents", "Agenten", NeonCyan, Modifier.weight(1f))
            MetricChip("$providers", "Provider", ElectricBlue, Modifier.weight(1f))
            MetricChip(if (state.online && s != null) "$uptimeHours h" else "—", "Laufzeit", NeonPink, Modifier.weight(1f))
        }

        /* ---- Drei Einstiegskarten ---- */
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            GlassCard(accent = NeonCyan, modifier = Modifier.weight(1f)) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Filled.Shield, null, tint = NeonCyan, modifier = Modifier.size(26.dp))
                    Spacer(Modifier.height(6.dp))
                    Text("Systemstatus", fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                    Spacer(Modifier.height(10.dp))
                    Text(if (state.online) "Online" else "Offline", color = if (state.online) NeonCyan else TextMuted, style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.height(6.dp))
                    Text(
                        if (state.online) "Hub verbunden" else "Hub nicht erreichbar",
                        style = MaterialTheme.typography.labelSmall, color = TextMuted, fontSize = 10.sp
                    )
                }
            }
            GlassCard(accent = ElectricBlue, modifier = Modifier.weight(1f)) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.fillMaxWidth().clickable { onChat() }
                ) {
                    Icon(Icons.Filled.ChatBubble, null, tint = ElectricBlue, modifier = Modifier.size(26.dp))
                    Spacer(Modifier.height(6.dp))
                    Text("KI-Chat", fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                    Spacer(Modifier.height(10.dp))
                    Text(modelLabel, color = ElectricBlue, style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(6.dp))
                    Text(if (llmState == "recently_verified") "Kürzlich echte Antwort" else "Modellverbindung prüfen", style = MaterialTheme.typography.labelSmall, color = TextMuted, fontSize = 10.sp)
                }
            }
            GlassCard(accent = NeonPink, modifier = Modifier.weight(1f)) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.fillMaxWidth().clickable { onVillas() }
                ) {
                    Icon(Icons.Filled.Folder, null, tint = NeonPink, modifier = Modifier.size(26.dp))
                    Spacer(Modifier.height(6.dp))
                    Text("Villen", fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                    Spacer(Modifier.height(10.dp))
                    NeonRing(
                        if (state.villas.isNotEmpty()) running.toFloat() / state.villas.size else 0f,
                        "$running", NeonPink
                    )
                    Spacer(Modifier.height(6.dp))
                    Text("${state.villas.size} Villen · $running aktiv · $waiting warten", style = MaterialTheme.typography.labelSmall, color = TextMuted, fontSize = 10.sp)
                }
            }
        }

        /* ---- Top 3: die drei weitesten Villen (grafisch, unterhalb Villa-Anzahl/Systemstatus) ---- */
        if (topVillas.isNotEmpty()) {
            GlassCard(accent = NeonCyan, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.fillMaxWidth()) {
                    Text(
                        "TOP 3 · DIE WEITESTEN VILLEN",
                        style = MaterialTheme.typography.labelSmall,
                        color = TextMuted,
                        fontWeight = FontWeight.Bold,
                        fontSize = 10.sp
                    )
                    Spacer(Modifier.height(8.dp))
                    val accents = listOf(NeonCyan, ElectricBlue, NeonPink)
                    topVillas.forEachIndexed { idx, (vName, vScore, vPhase) ->
                        val accent = accents.getOrElse(idx) { NeonCyan }
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 5.dp)
                        ) {
                            Text(
                                "${idx + 1}.",
                                fontWeight = FontWeight.Bold,
                                fontSize = 13.sp,
                                color = accent
                            )
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(
                                    vName,
                                    fontWeight = FontWeight.SemiBold,
                                    fontSize = 12.sp,
                                    color = TextMain,
                                    maxLines = 1
                                )
                                Spacer(Modifier.height(3.dp))
                                /* Grafischer Fortschrittsbalken (Marktreife 0-100) */
                                Box(
                                    Modifier
                                        .fillMaxWidth()
                                        .height(6.dp)
                                        .clip(RoundedCornerShape(3.dp))
                                        .background(TextMuted.copy(alpha = 0.18f))
                                ) {
                                    Box(
                                        Modifier
                                            .fillMaxWidth(vScore.coerceIn(0, 100) / 100f)
                                            .height(6.dp)
                                            .clip(RoundedCornerShape(3.dp))
                                            .background(accent)
                                    )
                                }
                                Text(
                                    vPhase,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = TextMuted,
                                    fontSize = 9.sp
                                )
                            }
                            Spacer(Modifier.width(10.dp))
                            Text(
                                "$vScore",
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.sp,
                                color = accent
                            )
                            Text(
                                "/100",
                                style = MaterialTheme.typography.labelSmall,
                                color = TextMuted,
                                fontSize = 9.sp
                            )
                        }
                    }
                }
            }
        }

        /* ---- Deep Agent: eigener Entwicklungs-Bereich abseits der Villen ---- */
        GlassCard(accent = NeonPink, modifier = Modifier.fillMaxWidth().clickable { onDeepAgent() }) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(12.dp)) {
                Icon(Icons.Filled.Add, null, tint = NeonPink, modifier = Modifier.size(22.dp))
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text("Deep Agent", fontWeight = FontWeight.SemiBold, fontSize = 13.sp, color = TextMain)
                    Text("Eigene App-Idee umsetzen · mit Verlauf, Anhaengen, Gedaechtnis", style = MaterialTheme.typography.labelSmall, color = TextMuted, fontSize = 10.sp)
                }
                Text("NEU >", fontWeight = FontWeight.Bold, fontSize = 12.sp, color = NeonPink)
            }
        }

        /* ---- Aktivitaet: Nachrichten, offene/erledigte Aufgaben, Sparkline ---- */
        GlassCard(accent = ElectricBlue) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Aktivität", fontWeight = FontWeight.Bold, fontSize = 16.sp)
                Spacer(Modifier.weight(1f))
                NeonChip(if (state.live) "LIVE" else "PAUSE", if (state.live) NeonCyan else TextMuted)
            }
            Text("Letzte 24 Stunden · Hub-Laufzeit ${uptimeHours} h", style = MaterialTheme.typography.labelSmall, color = TextMuted)
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.Bottom) {
                Text("$messages", fontWeight = FontWeight.ExtraBold, fontSize = 38.sp, color = TextMain)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.padding(bottom = 6.dp)) {
                    Text("Nachrichten im Hub", style = MaterialTheme.typography.labelSmall, color = TextMuted)
                    Text("$done erledigt · $open offen", style = MaterialTheme.typography.labelSmall, color = if (open > 0) NeonCyan else TextMuted)
                }
            }
            Spacer(Modifier.height(12.dp))
            if (maturityScores.size >= 2) {
                SparkLine(maturityScores, accent = NeonCyan)
                Text("Marktreife je Villa (0–100)", style = MaterialTheme.typography.labelSmall, color = TextMuted)
            } else {
                Text("Graph erscheint, sobald Villen Reifegrade erarbeiten.", style = MaterialTheme.typography.labelSmall, color = TextMuted)
            }
        }

        /* ---- Superagent-Banner: eigener Einstieg in die autonome Entwicklung ---- */
        GlassCard(accent = NeonCyan) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                NeonIconPlate(
                    icon = { Icon(Icons.Filled.SmartToy, null, tint = NeonCyan, modifier = Modifier.size(28.dp)) },
                    accent = NeonCyan, size = 56.dp
                )
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text("SUPERAGENT", fontWeight = FontWeight.ExtraBold, fontSize = 17.sp)
                    Text("Autonome KI-Assistentin · Villa-Evolution", style = MaterialTheme.typography.bodySmall, color = TextMuted)
                    Spacer(Modifier.height(6.dp))
                    NeonChip("LIVE AKTIV", NeonCyan)
                }
                TextButton(onClick = onSuperagent) { Text("Öffnen ›") }
            }
        }

        /* ---- Schnellzugriff: System- und Routen-Check bleibt einen Fingertipp entfernt ---- */
        TextButton(onClick = onDiagnostics, modifier = Modifier.fillMaxWidth()) {
            Icon(Icons.Filled.HealthAndSafety, null, tint = Aqua, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
            Text("Diagnose & Routen öffnen")
        }
    }
}
    }
