package dev.villaforge.app.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/**
 * Grafik-Bausteine (v1.20.0): animierter Ring-Fortschritt und gestapelter
 * Statusbalken — reine Canvas-Zeichnung, keine externen Chart-Bibliotheken.
 */
@Composable
fun RingProgress(score: Int, color: Color, modifier: Modifier = Modifier) {
    var started by remember { mutableStateOf(false) }
    LaunchedEffect(score) { started = true }
    val sweep by animateFloatAsState(
        targetValue = if (started) (score.coerceIn(0, 100)) / 100f else 0f,
        animationSpec = tween(900),
        label = "reifegrad"
    )
    Box(modifier.size(64.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(64.dp)) {
            val stroke = Stroke(width = 8.dp.toPx(), cap = StrokeCap.Round)
            drawArc(color = color.copy(alpha = 0.15f), startAngle = -90f, sweepAngle = 360f, useCenter = false, style = stroke)
            if (sweep > 0.005f) {
                drawArc(color = color, startAngle = -90f, sweepAngle = 360f * sweep, useCenter = false, style = stroke)
            }
        }
        Text("$score", fontWeight = FontWeight.Bold)
    }
}

/** Gestapelter Statusbalken: Anteile (Anzahl je Farbe) als ein Balken. */
@Composable
fun StackedBar(parts: List<Pair<Int, Color>>, modifier: Modifier = Modifier) {
    val total = parts.sumOf { it.first }.coerceAtLeast(1)
    Canvas(modifier) {
        var x = 0f
        for ((count, c) in parts) {
            if (count <= 0) continue
            val w = size.width * count / total
            drawRect(color = c, topLeft = Offset(x, 0f), size = Size(w, size.height))
            x += w
        }
    }
}
