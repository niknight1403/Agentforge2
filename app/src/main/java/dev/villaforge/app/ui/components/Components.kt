package dev.villaforge.app.ui.components

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.height
import androidx.compose.ui.layout.ContentScale
import coil.compose.AsyncImage
import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.villaforge.app.ui.theme.Aqua
import dev.villaforge.app.ui.theme.NeonCyan
import dev.villaforge.app.ui.theme.NeonPink
import dev.villaforge.app.ui.theme.Border
import dev.villaforge.app.ui.theme.Surface2
import dev.villaforge.app.ui.theme.Surface3
import dev.villaforge.app.ui.theme.TextMuted
import dev.villaforge.app.ui.theme.statusColor

/**
 * Wiederverwendbare Profi-Bausteine (v1.14.0): Kacheln mit animierten
 * Kennzahlen, Balkendiagramm, Status-Badge mit Puls, Shimmer-Skelett,
 * Leerzustand und Abschnittskarten. Ohne Logik, rein darstellend — Daten
 * kommen immer von aussen.
 */

/** KPI-Kachel: kleines Label, grosser Kennwert in Akzentfarbe. */
@Composable
fun StatTile(label: String, value: String, accent: Color = Aqua, modifier: Modifier = Modifier) {
    Column(
        modifier
            .clip(RoundedCornerShape(14.dp))
            .background(Surface2)
            .padding(horizontal = 14.dp, vertical = 12.dp)
    ) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = TextMuted)
        Spacer(Modifier.height(4.dp))
        Text(value, fontWeight = FontWeight.Bold, fontSize = 20.sp, color = accent)
    }
}

/** Kennzahl-Kachel mit hochzaehlendem Wert: dezente Bewegung statt Sprung. */
@Composable
fun AnimatedStatTile(label: String, target: Int, accent: Color = Aqua, modifier: Modifier = Modifier) {
    val progress by androidx.compose.animation.core.animateIntAsState(
        targetValue = target,
        animationSpec = tween(durationMillis = 600),
        label = "counter"
    )
    StatTile(
        label = label, value = "$progress", accent = accent,
        modifier = modifier.semantics { contentDescription = "$label: $target" }
    )
}

/** Kompaktes Balkendiagramm (Canvas), letzter Balken hervorgehoben. */
@Composable
fun MiniBars(values: List<Float>, modifier: Modifier = Modifier, barColor: Color = Aqua) {
    val max = (values.maxOrNull() ?: 1f).coerceAtLeast(0.001f)
    /* Sprint 29: Balken wachsen beim Erscheinen weich hoch. */
    var started by remember { mutableStateOf(false) }
    LaunchedEffect(values) { started = true }
    val grow by animateFloatAsState(if (started) 1f else 0f, animationSpec = tween(700), label = "balken")
    Canvas(modifier.fillMaxWidth().height(56.dp)) {
        if (values.isEmpty()) return@Canvas
        val w = size.width / values.size
        values.forEachIndexed { i, v ->
            val h = (v / max) * size.height * 0.92f * grow
            drawRoundRect(
                color = if (i == values.lastIndex) barColor else barColor.copy(alpha = 0.45f),
                topLeft = Offset(i * w + w * 0.18f, size.height - h),
                size = Size(w * 0.64f, h),
                cornerRadius = CornerRadius(6f, 6f)
            )
        }
    }
}

/** Status-Pille mit sanftem Farbhaftergrund. */
@Composable
fun StatusPill(text: String, color: Color = NeonCyan) {
    Text(
        text,
        color = color,
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(color.copy(alpha = 0.12f))
            .padding(horizontal = 10.dp, vertical = 4.dp)
    )
}

/**
 * Semantisches Status-Badge: Farbe kommt aus statusColor(), der Puls-Punkt
 * atmet leicht, wenn der Zustand "laeuft" bedeutet.
 */
@Composable
fun StatusBadge(status: String) {
    val color = statusColor(status)
    val pulsing = status == "RUNNING" || status == "läuft" || status == "ARBEITET"
    val pulse by if (pulsing) {
        rememberInfiniteTransition(label = "pulse").animateFloat(
            initialValue = 0.5f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(700, easing = LinearEasing), RepeatMode.Reverse),
            label = "pulseAlpha"
        )
    } else {
        androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(1f) }
    }
    Row(
        Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(color.copy(alpha = 0.16f))
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(color.copy(alpha = pulse)))
        Spacer(Modifier.width(6.dp))
        Text(status, style = MaterialTheme.typography.bodySmall, color = color)
    }
}

/** Shimmer-Kachel fuer Ladezustaende statt Spinner: ruhig und informativ. */
@Composable
fun SkeletonBox(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "shimmer")
    val shift by transition.animateFloat(
        initialValue = -1f,
        targetValue = 2f,
        animationSpec = infiniteRepeatable(tween(1200, easing = LinearEasing)),
        label = "shimmerShift"
    )
    Box(
        modifier
            .clip(RoundedCornerShape(14.dp))
            .background(
                Brush.linearGradient(
                    listOf(Surface2, Surface3, Surface2),
                    start = Offset(shift * 300f, 0f),
                    end = Offset(shift * 300f + 300f, 120f)
                )
            )
    )
}

/** Skelett-Liste fuer den Ladezustand einer ganzen Seite. */
@Composable
fun SkeletonList(rows: Int = 3) {
    Column(verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(10.dp)) {
        repeat(rows) {
            SkeletonBox(Modifier.fillMaxWidth().height(88.dp))
        }
    }
}

/** Leerzustand mit Titel, Hinweis und Icon statt nackter "nichts da"-Zeile. */
@Composable
fun EmptyState(title: String, hint: String) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(
            Modifier.size(56.dp).clip(CircleShape).background(Aqua.copy(alpha = 0.12f)),
            contentAlignment = Alignment.Center
        ) {
            Text("◆", color = Aqua, fontSize = 22.sp)
        }
        Spacer(Modifier.height(12.dp))
        Text(title, fontWeight = FontWeight.SemiBold, color = Color(0xFFECF0FF))
        Spacer(Modifier.height(4.dp))
        Text(hint, style = MaterialTheme.typography.bodySmall, color = TextMuted)
    }
}

/** Overline-Sektionslabel: ordnet Listen und Sektionen mit Letter-Spacing. */
@Composable
fun SectionHeader(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        modifier = Modifier.padding(top = 10.dp)
    )
}

/** KI-generiertes Villen-Bild (kostenloser Designer: Pollinations.ai, ohne API-Key). */
@Composable
fun HeroImage(idea: String, seed: Long, modifier: Modifier = Modifier) {
    val prompt = java.net.URLEncoder.encode(
        "modern premium app concept hero image, ${idea.take(140)}, dark futuristic gradient, teal and violet neon accents, minimalist professional digital art, high quality",
        "UTF-8"
    )
    AsyncImage(
        model = "https://image.pollinations.ai/prompt/$prompt?width=720&height=320&nologo=true&seed=${seed * 31 + 7}",
        contentDescription = "KI-generiertes Villen-Bild",
        contentScale = ContentScale.Crop,
        modifier = modifier
    )
}

/** Abschnittskarte mit Verlaufstitelbalken und freiem Inhalt; Groesse animiert sich sanft. */
@Composable
fun SectionCard(title: String, content: @Composable () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .animateContentSize(animationSpec = tween(250))
            .clip(RoundedCornerShape(18.dp))
            .border(0.8.dp, Brush.linearGradient(listOf(NeonCyan.copy(alpha = 0.35f), NeonPink.copy(alpha = 0.22f))), RoundedCornerShape(18.dp))
            .background(Surface2.copy(alpha = 0.86f))
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .background(Brush.linearGradient(listOf(NeonCyan.copy(alpha = 0.10f), NeonPink.copy(alpha = 0.06f))))
                .padding(horizontal = 14.dp, vertical = 10.dp)
        ) {
            Text(title, fontWeight = FontWeight.SemiBold)
        }
        Column(Modifier.padding(14.dp)) {
            content()
        }
    }
}

/** Kleine Kennzahl-Zeile fuer dichte Listen. */
@Composable
fun KeyRow(label: String, value: String) {
    Column(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = MaterialTheme.typography.bodySmall, color = TextMuted)
            Spacer(Modifier.weight(1f))
            Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.height(2.dp))
        Box(
            Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(Border)
        )
    }
}
