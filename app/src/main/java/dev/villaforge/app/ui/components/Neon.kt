package dev.villaforge.app.ui.components

import dev.villaforge.app.ui.theme.Gold
import dev.villaforge.app.ui.theme.GoldGradient
import dev.villaforge.app.ui.theme.PremiumInk
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.Canvas
import dev.villaforge.app.ui.theme.Border
import dev.villaforge.app.ui.theme.NeonCyan
import dev.villaforge.app.ui.theme.NeonGradient
import dev.villaforge.app.ui.theme.NeonPink
import dev.villaforge.app.ui.theme.Surface2
import dev.villaforge.app.ui.theme.TextMuted

/*
 * Cyber-Neon-Bausteine (v1.31.0): Glas-Karten mit duennem Neon-Rand,
 * Fortschrittsringe, Sparklines und Status-Chips im Control-Center-Look.
 */

/** Glas-Karte: halbtransparente Flaeche, Neon-Rand, optionaler Glow in der Akzentfarbe. */
@Composable
fun GlassCard(
    modifier: Modifier = Modifier,
    accent: Color = NeonCyan,
    glow: Boolean = true,
    content: @Composable () -> Unit
) {
    val shape = RoundedCornerShape(20.dp)
    Box(
        modifier
            .clip(shape)
            .background(Brush.linearGradient(listOf(Surface2.copy(alpha = 0.92f), Surface2.copy(alpha = 0.65f))))
            .border(0.8.dp, Brush.linearGradient(listOf(accent.copy(alpha = 0.55f), accent.copy(alpha = 0.18f))), shape)
            .padding(16.dp)
    ) {
        if (glow) {
            // dezenter Neon-Schein oben links, damit die Karte "leuchtet"
            Box(Modifier.fillMaxWidth().height(1.dp).background(Brush.horizontalGradient(listOf(accent, Color.Transparent))))
        }
        Column { content() }
    }
}

/** Kleiner Kennzahlen-Chip: Wert fett, Label darunter in gedecktem Ton. */
@Composable
fun MetricChip(value: String, label: String, accent: Color = NeonCyan, modifier: Modifier = Modifier) {
    GlassCard(modifier, accent = accent, glow = false) {
        Text(value, fontWeight = FontWeight.Bold, fontSize = 18.sp, color = accent)
        Spacer(Modifier.height(2.dp))
        Text(label, style = MaterialTheme.typography.labelSmall, color = TextMuted)
    }
}

/** Neon-Fortschrittsring mit Prozent-Text in der Mitte (Canvas, kein Library-Import). */
@Composable
fun NeonRing(percent: Float, label: String = "", accent: Color = NeonCyan, size: Dp = 64.dp, stroke: Dp = 5.dp) {
    Box(Modifier.size(size + 22.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(size + 14.dp)) {
            val strokePx = stroke.toPx()
            val inset = strokePx / 2
            drawArc(
                color = Border,
                startAngle = 0f, sweepAngle = 360f, useCenter = false,
                topLeft = Offset(inset, inset),
                size = androidx.compose.ui.geometry.Size(this.size.width - strokePx, this.size.height - strokePx),
                style = Stroke(width = strokePx, cap = StrokeCap.Round)
            )
            drawArc(
                brush = Brush.sweepGradient(listOf(accent, NeonPink, accent)),
                startAngle = -90f, sweepAngle = 360f * (percent.coerceIn(0f, 1f)), useCenter = false,
                topLeft = Offset(inset, inset),
                size = androidx.compose.ui.geometry.Size(this.size.width - strokePx, this.size.height - strokePx),
                style = Stroke(width = strokePx, cap = StrokeCap.Round)
            )
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("${(percent * 100).toInt()}", fontWeight = FontWeight.Bold, fontSize = 14.sp)
            if (label.isNotBlank()) Text(label, style = MaterialTheme.typography.labelSmall, color = TextMuted, fontSize = 9.sp)
        }
    }
}

/** Neon-Sparkline: Linienzug ueber Werte (0..max), Cyan-Linie mit Flaeche in Verlauf. */
@Composable
fun SparkLine(values: List<Float>, modifier: Modifier = Modifier, accent: Color = NeonCyan, height: Dp = 64.dp) {
    Canvas(modifier.fillMaxWidth().height(height)) {
        if (values.size < 2) return@Canvas
        val maxV = (values.maxOrNull() ?: 1f).coerceAtLeast(1f)
        val stepX = size.width / (values.size - 1)
        val y = { i: Int -> size.height - (values[i] / maxV) * (size.height * 0.85f) - size.height * 0.05f }
        val line = Path().apply {
            moveTo(0f, y(0))
            for (i in 1 until values.size) lineTo(i * stepX, y(i))
        }
        val area = Path().apply {
            addPath(line)
            lineTo((values.size - 1) * stepX, size.height)
            lineTo(0f, size.height)
            close()
        }
        drawPath(area, Brush.verticalGradient(listOf(accent.copy(alpha = 0.28f), accent.copy(alpha = 0.02f))))
        drawPath(line, accent, style = Stroke(width = 2.4.dp.toPx(), cap = StrokeCap.Round))
    }
}

/** Status-Chip: leuchtender Punkt + Text (Online/LIVE-Aktiv etc.). */
@Composable
fun NeonChip(text: String, color: Color = NeonCyan, modifier: Modifier = Modifier) {
    Box(
        modifier
            .clip(RoundedCornerShape(50))
            .background(color.copy(alpha = 0.14f))
            .padding(horizontal = 10.dp, vertical = 4.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(color))
            Spacer(Modifier.width(5.dp))
            Text(text, style = MaterialTheme.typography.labelSmall, color = color, fontWeight = FontWeight.SemiBold)
        }
    }
}

/** Runde Icon-Platte mit Neon-Ring — Logo/Badge-Baustein des Headers. */
@Composable
fun NeonIconPlate(icon: @Composable () -> Unit, accent: Color = NeonCyan, size: Dp = 40.dp) {
    Box(
        Modifier.size(size).clip(CircleShape).background(accent.copy(alpha = 0.12f)).border(1.dp, accent.copy(alpha = 0.6f), CircleShape),
        contentAlignment = Alignment.Center
    ) { icon() }
}

/*
 * Quality-Layer v2 — Premium-Aurora-Hintergrund: dreistufige radiale
 * Lichtkoerper (Violett, Cyan, Gold) ueber tiefem Premium-Ink. Rein statisch
 * gezeichnet (keine Animation) — stets fluessig auch auf aelteren Handys.
 */
/**
 * Quality-Layer v2 (2026-10-19, Struktur-Bereinigung): Zentrale Aurora-
 * Hintergrund-Funktion als Modifier statt pro Screen gewrappter Komponente.
 * EIN Aufruf auf App-Ebene (VillaForgeApp Scaffold-Ebene) versieht ALLE
 * Screens mit dem Premium-Look: Premium-Ink-Basis plus drei radiale
 * Lichtkoerper (Violett oben links, Cyan rechts, Gold unten). Statisch
 * gerendert, kein Animations-Overhead, handy-schonend.
 */
fun Modifier.auroraBg(): Modifier = drawBehind {
    drawRect(color = PremiumInk, size = size)
    drawRect(brush = Brush.radialGradient(
        colors = listOf(Color(0x33241A63), Color(0x00241A63)),
        center = Offset(size.width * 0.12f, size.height * 0.05f),
        radius = size.width * 1.35f))
    drawRect(brush = Brush.radialGradient(
        colors = listOf(Color(0x26007A7A), Color(0x00007A7A)),
        center = Offset(size.width * 0.95f, size.height * 0.55f),
        radius = size.width * 1.1f))
    drawRect(brush = Brush.radialGradient(
        colors = listOf(Color(0x2EE8C27A), Color(0x00E8C27A)),
        center = Offset(size.width * 0.55f, size.height * 1.02f),
        radius = size.width * 0.9f))
}


/*
 * Quality-Layer v2 — GoldChip: exklusiver Elite-/Unlimited-Statusmarker
 * mit Gold-Verlauf und feinem Rand (44dp-taugliche Grosse fuer Touch).
 */
@Composable
fun GoldChip(text: String, modifier: Modifier = Modifier) {
    Box(
        modifier
            .clip(RoundedCornerShape(50))
            .background(Color(0x22E8C27A))
            .border(1.dp, Color(0x66E8C27A), RoundedCornerShape(50))
            .padding(horizontal = 10.dp, vertical = 5.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(Gold))
            Spacer(Modifier.width(5.dp))
            Text(text, color = Gold, fontWeight = FontWeight.ExtraBold, fontSize = 10.sp, letterSpacing = 1.2.sp)
        }
    }
}
