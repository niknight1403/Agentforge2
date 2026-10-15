package dev.villaforge.app.ui.screens

import android.annotation.SuppressLint
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import dev.villaforge.app.ui.MainViewModel
import dev.villaforge.app.ui.UiState
import dev.villaforge.app.ui.components.EmptyState
import dev.villaforge.app.ui.components.KeyRow
import dev.villaforge.app.ui.components.SectionCard
import dev.villaforge.app.ui.components.SectionHeader
import dev.villaforge.app.ui.components.StatusBadge
import dev.villaforge.app.ui.theme.Aqua
import dev.villaforge.app.ui.theme.Danger
import dev.villaforge.app.ui.theme.TextMuted

/*
 * Entwicklungsbereich (v1.24.0): Chat-Entwicklungsfenster mit Deep Agent,
 * App-Live-Ansicht (WebView auf den Web-Build der Villa) und autonomer
 * Fertigstellung inklusive Produkt-Build mit APK-/Paket-Download.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DevScreen(state: UiState, viewModel: MainViewModel, onOpenVilla: (Long) -> Unit = {}) {
    val detail = state.detail ?: return
    var tab by remember { mutableStateOf(0) }

    Column(Modifier.fillMaxSize()) {
        state.error?.let { ErrorBanner(it) { viewModel.refreshAll() } }
        if (state.message.isNotBlank()) Text(state.message, color = Aqua, style = muted(), modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
        TabRow(selectedTabIndex = tab) {
            listOf("Aktivität", "Chat", "Live-Ansicht", "Fertigstellung").forEachIndexed { i, label ->
                Tab(selected = tab == i, onClick = { tab = i }, text = { Text(label) })
            }
        }
        when (tab) {
            0 -> ActivityTab(state, viewModel)
            1 -> ChatScreen(state, viewModel)
            2 -> LiveTab(state, viewModel)
            3 -> FinishTab(state, viewModel, onOpenVilla)
        }
    }
}

/** Aktivitaet: WAS/WARUM/WIE-Erklaerung plus Agenten-Timeline. */
@Composable
private fun ActivityTab(state: UiState, viewModel: MainViewModel) {
    val detail = state.detail ?: return
    LaunchedEffect(detail.villa.id) {
        viewModel.refreshActivity()
        viewModel.explain()
    }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        dev.villaforge.app.ui.components.HeroImage(
            idea = detail.villa.idea, seed = detail.villa.id,
            modifier = Modifier.fillMaxWidth().height(120.dp)
        )
        SectionCard("Was macht die Villa gerade?") {
            val ex = state.explanation
            if (ex != null) {
                for ((label, key) in listOf("Was" to "was", "Warum" to "warum", "Wie" to "wie", "Nächster Schritt" to "naechsterSchritt")) {
                    val v = ex.optString(key)
                    if (v.isNotBlank()) {
                        Text(label.uppercase(), style = muted(), color = Aqua, fontWeight = FontWeight.Bold)
                        Text(v, style = muted())
                        if (key != "naechsterSchritt") Spacer(Modifier.height(6.dp))
                    }
                }
                Spacer(Modifier.height(4.dp))
                OutlinedButton(onClick = { viewModel.explain() }, enabled = !state.busy) { Text("Neu erklären") }
            } else {
                Text("Erklärung wird geladen …", style = muted(), color = TextMuted)
            }
        }
        SectionHeader("Agenten-Aktivität")
        val activity = state.activity
        if (activity == null || activity.isEmpty()) {
            Text("Noch keine Meldungen.", style = muted(), color = TextMuted)
        } else {
            activity.take(12).forEach { m ->
                val agent = detail.agents.firstOrNull { it.id == m.agentId }
                Column(Modifier.fillMaxWidth()) {
                    Row {
                        Text(agent?.name ?: (if (m.role == "user") "Du" else "Agent"), fontWeight = FontWeight.SemiBold, color = Aqua, style = muted())
                        Spacer(Modifier.width(6.dp))
                        Text(
                            java.text.SimpleDateFormat("dd.MM. HH:mm", java.util.Locale.GERMANY).format(java.util.Date(m.createdAt)),
                            style = muted(), color = TextMuted
                        )
                    }
                    Text(m.content.take(240), style = muted())
                    Spacer(Modifier.height(6.dp))
                }
            }
        }
    }
}

/** Live-Ansicht: Web-Build der Villa im WebView, sonst Status und Build-Einstieg. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun LiveTab(state: UiState, viewModel: MainViewModel) {
    val preview = state.preview
    if (preview?.optString("type") == "web") {
        val url = state.serverUrl.trimEnd('/') + preview.optString("path")
        val headers = viewModel.authHeader()?.let { mapOf("Authorization" to it) } ?: emptyMap()
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                WebView(ctx).apply {
                    settings.javaScriptEnabled = true
                    webViewClient = object : WebViewClient() {
                        // Alle Unter-Ressourcen (JS/CSS/Bilder) mit Auth-Header laden,
                        // sonst 401 auf Assets -> weisse Seite (Live-Ansicht-Bugfix)
                        override fun shouldInterceptRequest(
                            view: WebView,
                            request: android.webkit.WebResourceRequest
                        ): android.webkit.WebResourceResponse? {
                            val u = request.url.toString()
                            return if (u.startsWith(state.serverUrl.trimEnd('/'))) {
                                viewModel.previewResource(u) ?: super.shouldInterceptRequest(view, request)
                            } else super.shouldInterceptRequest(view, request)
                        }
                    }
                }
            },
            update = { wv -> if (wv.url != url) wv.loadUrl(url, headers) }
        )
    } else {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            EmptyState(
                title = "Noch keine Live-Ansicht",
                hint = preview?.optString("hint")
                    ?: "Sobald die Villa einen Web-Build erzeugt (dist-Ordner), laeuft die App hier live im Bild."
            )
            BuildCard(state, viewModel)
        }
    }
}

/** Autonome Fertigstellung: 24/7-Lauf, Vorschlaege aus Phasen und Rat, Produkt-Build. */
@Composable
private fun FinishTab(state: UiState, viewModel: MainViewModel, onOpenVilla: (Long) -> Unit = {}) {
    val detail = state.detail ?: return
    val active = detail.running || detail.villa.status == "RUNNING" || detail.villa.status == "STOPPING"

    LaunchedEffect(detail.villa.id) {
        viewModel.refreshCouncil(detail.villa.id)
        viewModel.refreshProposals()
        viewModel.refreshEvolution(detail.villa.id)
    }
    /* Waehrend eines autonomen Laufs Stand und Build nachladen. */
    LaunchedEffect(detail.villa.id, active) {
        while (active) {
            kotlinx.coroutines.delay(5000)
            viewModel.refreshDetail()
            viewModel.refreshBuild()
            viewModel.refreshEvolution(detail.villa.id)
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        /* Analyse-Vorschlaege: bessere Alternativen mit klarer Begruendung. */
        SectionHeader("Analyse-Vorschläge (bessere Alternativen)")
        val props = state.proposals
        if (props == null || props.length() == 0) {
            Text("Noch keine Vorschläge. Der Scout analysiert alle 6 h - oder du forderst jetzt eine bessere Alternative an.",
                style = muted(), color = TextMuted)
        } else {
            (0 until props.length()).forEach { i ->
                val p = props.optJSONObject(i) ?: return@forEach
                var showPrompt by remember(p.optLong("id")) { mutableStateOf(false) }
                SectionCard(p.optString("title")) {
                    Text("Projekt: " + p.optString("proposedName"), fontWeight = FontWeight.Bold, color = Aqua)
                    Spacer(Modifier.height(4.dp))
                    Text("Warum es sich lohnt:", style = muted(), color = TextMuted)
                    Text(p.optString("whyBetter"), style = muted())
                    val benefits = p.optJSONArray("benefits")
                    if (benefits != null) {
                        (0 until benefits.length()).forEach { b ->
                            Text("· " + benefits.optString(b), style = muted())
                        }
                    }
                    TextButton(onClick = { showPrompt = !showPrompt }) {
                        Text(if (showPrompt) "Masterprompt verbergen" else "Masterprompt ansehen")
                    }
                    if (showPrompt) Text(p.optString("masterprompt"), style = muted(), color = TextMuted)
                    if (p.optString("status") == "pending") {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { viewModel.approveProposal(p.optLong("id")) { id -> onOpenVilla(id) } }, enabled = !state.busy) {
                                Text("Bestätigen & Villa gründen")
                            }
                            OutlinedButton(onClick = { viewModel.rejectProposal(p.optLong("id")) }, enabled = !state.busy) {
                                Text("Ablehnen")
                            }
                        }
                    } else {
                        val vid = p.optLong("villaId", -1)
                        Text("Villa #$vid wurde gegründet.", style = muted(), color = dev.villaforge.app.ui.theme.Success)
                        if (vid > 0) TextButton(onClick = { onOpenVilla(vid) }) { Text("Villa öffnen") }
                    }
                }
            }
        }
        OutlinedButton(onClick = { viewModel.scanProposals() }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
            Text("Jetzt nach besserer Alternative suchen")
        }

        SectionCard("Autonome Fertigstellung") {
            Text(
                if (active) "Die Villa arbeitet gerade autonom: Phasen-Aufgaben, Rat und Umsatz-Zyklus steuern die Wellen."
                else "Starte den 24/7-Lauf: Die Agenten planen, bauen und verbessern das Projekt eigenstaendig weiter.",
                style = muted(), color = TextMuted
            )
            Spacer(Modifier.height(8.dp))
            if (active) {
                StatusBadge(detail.villa.status + " · läuft")
            } else {
                Button(onClick = { viewModel.orchestrate() }, enabled = !state.busy) {
                    Text("Autonom fertigstellen starten")
                }
            }
        }

        /* ---- Villa-Evolution: jede Villa schlaegt selbst vor, wie es weitergeht. ---- */
        SectionHeader("Villa-Evolution (nächste Phasen · Perfektion · Marketplace)")
        val evo = state.evolution
        if (evo == null) {
            Text("Status der Villa-Evolution wird geladen …", style = muted(), color = TextMuted)
        } else {
            val stage = evo.optString("stage")
            val rounds = evo.optInt("phaseRounds", 0)
            val done = evo.optInt("done", 0)
            val open = evo.optInt("open", 0)
            val stageText = when (stage) {
                "DEVELOPING" -> "Die Villa arbeitet an ihren aktuellen Aufgaben ($open offen, $done erledigt). Ist alles erledigt, schlägt sie die nächsten Phasen vor."
                "PLANNING_NEXT" -> "Alle Aufgaben sind erledigt ($done) — die Villa schlägt jetzt die nächsten Phasen vor (Runde ${rounds + 1})."
                "PERFECTING" -> "Alle Phasen sind abgeschlossen (Runde $rounds bestätigt) — jetzt geht es um Perfektionierung, Optimierung und Marktreife."
                else -> "Stufe $stage"
            }
            Text(stageText, style = muted(), color = TextMuted)
            val etaMin = evo.optInt("etaMin", 0)
            val cur = evo.optJSONArray("currentTasks")
            if (cur != null && cur.length() > 0) {
                Text(
                    "Jetzt: " + (0 until cur.length()).joinToString(" · ") { cur.optString(it) } +
                        (if (etaMin > 0) "  —  Restdauer ≈ ${etaMin} Min" else ""),
                    style = muted(), color = Aqua, fontSize = 12.sp
                )
            } else if (open > 0 && etaMin > 0) {
                Text("$open offen — Restdauer ≈ ${etaMin} Min", style = muted(), color = TextMuted, fontSize = 12.sp)
            }
            if (evo.optBoolean("workspaceEmpty", false)) {
                Text(
                    "Achtung: Der Projektordner ist noch leer — erledigte Aufgaben haben bisher nur Berichte erzeugt. Neue Vorschläge fordern jetzt echten Code ein.",
                    style = muted(), color = dev.villaforge.app.ui.theme.Warn
                )
            }
            val evoProps = evo.optJSONArray("proposals")
            if (evoProps != null && evoProps.length() > 0) {
                (0 until evoProps.length()).forEach { i ->
                    val pr = evoProps.optJSONObject(i) ?: return@forEach
                    val kind = pr.optString("kind")
                    val kindLabel = when (kind) {
                        "PERFECT" -> "Perfektionierung"
                        "MARKETPLACE" -> "AI Marketplace"
                        else -> "Nächste Phasen (Runde ${pr.optInt("round", 1)})"
                    }
                    val items = pr.optJSONArray("items")
                    val avgTask = if (open > 0 && etaMin > 0) (etaMin / open).coerceAtLeast(1) else 3
                    val sprintEta = (items?.length() ?: 0) * avgTask
                    SectionCard(kindLabel + ": " + pr.optString("title") + "  ·  ≈ ${sprintEta} Min") {
                        Text(pr.optString("summary"), style = muted())
                        Spacer(Modifier.height(4.dp))
                        (0 until (items?.length() ?: 0)).forEach { k ->
                            val it = items?.optJSONObject(k)
                            Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                                Text("· " + (it?.optString("title") ?: ""), fontWeight = FontWeight.SemiBold)
                                Text((it?.optString("description") ?: "") + "  [" + (it?.optString("role") ?: "") + "]", style = muted(), color = TextMuted)
                            }
                        }
                        if (pr.optString("status") == "pending") {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(
                                    onClick = { viewModel.approveEvolution(detail.villa.id, pr.optLong("id")) },
                                    enabled = !state.busy
                                ) { Text("Bestätigen & weiterentwickeln") }
                                OutlinedButton(
                                    onClick = { viewModel.rejectEvolution(detail.villa.id, pr.optLong("id")) },
                                    enabled = !state.busy
                                ) { Text("Ablehnen") }
                            }
                        } else {
                            Text("Bestätigt — Aufgaben liegen an.", style = muted(), color = dev.villaforge.app.ui.theme.Success)
                        }
                    }
                }
            } else {
                Text("Kein offener Vorschlag — du kannst die Villa jetzt einen erzeugen lassen.", style = muted(), color = TextMuted)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = { viewModel.proposeEvolution(detail.villa.id, "NEXT_PHASES") },
                    enabled = !state.busy
                ) { Text("Nächste Phasen vorschlagen") }
                OutlinedButton(
                    onClick = { viewModel.proposeEvolution(detail.villa.id, "PERFECT") },
                    enabled = !state.busy
                ) { Text("Perfektionierung") }
                OutlinedButton(
                    onClick = { viewModel.proposeEvolution(detail.villa.id, "MARKETPLACE") },
                    enabled = !state.busy
                ) { Text("AI Marketplace") }
            }
        }

        SectionHeader("Entwicklungsvorschläge")
        val product = state.product
        val phases = product?.optJSONArray("phases")
        if (phases != null && phases.length() > 0) {
            (0 until phases.length()).forEach { i ->
                val ph = phases.optJSONObject(i) ?: return@forEach
                val pct = (ph.optDouble("ratio", 0.0) * 100).toInt()
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(ph.optString("title"), fontWeight = FontWeight.SemiBold)
                        Text("$pct %", style = muted(), color = if (pct >= 100) dev.villaforge.app.ui.theme.Success else TextMuted)
                    }
                    if (pct < 100 && !active) {
                        TextButton(onClick = { viewModel.orchestrate() }) { Text("Umsetzen") }
                    }
                }
            }
        } else {
            Text("Noch keine Phasen-Vorschläge — erst Lauf starten.", style = muted(), color = TextMuted)
        }
        val council = state.council
        val last = council?.optJSONObject(0)
        val proposals = last?.optJSONArray("proposals")
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Rat der Agenten · Runde ${last?.optInt("round") ?: 0}",
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f)
            )
            TextButton(onClick = { viewModel.triggerCouncil(detail.villa.id) }) { Text("Einberufen") }
            TextButton(
                onClick = { viewModel.adoptCouncil(detail.villa.id, last?.optLong("id") ?: 0L) },
                enabled = (proposals?.length() ?: 0) > 0
            ) { Text("Übernehmen") }
        }
        if (council == null || council.length() == 0) {
            Text("Noch keine Rat-Runde — jetzt einberufen.", style = muted(), color = TextMuted)
        }
        state.councilNote?.let {
            Text(it, style = muted(), color = dev.villaforge.app.ui.theme.Success)
        }
        (0 until (proposals?.length() ?: 0)).forEach { i ->
            val p = proposals?.optJSONObject(i)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(p?.optString("agent") ?: "", style = muted(), color = Aqua)
                    Text(p?.optString("text") ?: "", style = muted())
                }
            }
        }

        BuildCard(state, viewModel)
    }
}

/** Produkt-Build-Karte: Status, Start, APK-/Paket-Download und Log-Auszug. */
@Composable
private fun BuildCard(state: UiState, viewModel: MainViewModel) {
    val detail = state.detail ?: return
    val build = state.build
    val status = build?.optString("status") ?: "none"
    val context = LocalContext.current

    /* Solange der Build laeuft, Status abfragen bis er fertig ist. */
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(5000)
            val st = viewModel.state.value.build?.optString("status")
            if (st == "running") viewModel.refreshBuild() else break
        }
    }

    SectionCard("Produkt-Build (APK / Paket)") {
        KeyRow("Status", when (status) {
            "running" -> "baut gerade …"
            "ready" -> "bereit zum Download"
            "failed" -> "fehlgeschlagen"
            else -> "noch nicht gebaut"
        })
        build?.optString("kind")?.takeIf { it.isNotBlank() && it != "empty" }?.let { KeyRow("Projektart", it) }
        if (status == "ready" && build != null) {
            KeyRow(
                "Artefakt",
                build.optString("artifact") +
                    if (build.optLong("sizeBytes", 0) > 0) " · ${build.optLong("sizeBytes") / 1048576} MB" else ""
            )
        }
        build?.optString("error")?.takeIf { it.isNotBlank() }?.let {
            Spacer(Modifier.height(4.dp))
            Text(it, color = Danger, style = muted())
        }
        val log = build?.optJSONArray("log")
        if (log != null && log.length() > 0) {
            Spacer(Modifier.height(4.dp))
            (maxOf(0, log.length() - 4) until log.length()).forEach { i ->
                Text("· " + log.optString(i), style = muted(), color = TextMuted)
            }
        }
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = { viewModel.triggerBuild() },
                enabled = !state.busy && status != "running"
            ) { Text("Produkt bauen") }
            if (status == "ready") {
                Button(onClick = {
                    val url = state.serverUrl.trimEnd('/') + "/api/villas/${detail.villa.id}/build/download"
                    val name = build?.optString("artifact") ?: "villa-${detail.villa.id}.bin"
                    val request = android.app.DownloadManager.Request(android.net.Uri.parse(url))
                        .setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                        .setTitle("VillaForge · " + detail.villa.name)
                        .setMimeType(
                            when (build?.optString("artifactType")) {
                                "apk" -> "application/vnd.android.package-archive"
                                "tar.gz" -> "application/gzip"
                                else -> "application/zip"
                            }
                        )
                    request.setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, name)
                    viewModel.authHeader()?.let { request.addRequestHeader("Authorization", it) }
                    val dm = context.getSystemService(android.content.Context.DOWNLOAD_SERVICE) as android.app.DownloadManager
                    dm.enqueue(request)
                }) { Text("Download") }
            }
        }
        Spacer(Modifier.width(4.dp))
        Text(
            if (status == "ready" && build?.optString("kind") == "android") "Echte APK - direkt installierbar."
            else if (status == "ready") "Paket-Download mit Quellcode und Build. APKs entstehen bei Android-Projekten mit SDK auf dem Hub."
            else "Der Hub packt das Projekt der Villa: echte APKs bei Android-Projekten (SDK), sonst Paket.",
            style = muted(), color = TextMuted
        )
    }
}
