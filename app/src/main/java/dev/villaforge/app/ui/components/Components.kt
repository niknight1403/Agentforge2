package dev.villaforge.app.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.villaforge.app.ui.theme.Aqua
import dev.villaforge.app.ui.theme.Border
import dev.villaforge.app.ui.theme.Surface2
import dev.villaforge.app.ui.theme.TextMuted

/**
 * Wiederverwendbare Profi-Bausteine des v1.11.0-Redesigns: Kacheln,
 * Balkendiagramm, Status-Pille und Abschnittskarte. Ohne Logik, rein
 * darstellend — Daten kommen immer von aussen.
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

/** Kompaktes Balkendiagramm (Canvas), letzter Balken hervorgehoben. */
@Composable
fun MiniBars(values: List<Float>, modifier: Modifier = Modifier, barColor: Color = Aqua) {
    val max = (values.maxOrNull() ?: 1f).coerceAtLeast(0.001f)
    Canvas(modifier.fillMaxWidth().height(56.dp)) {
        if (values.isEmpty()) return@Canvas
        val w = size.width / values.size
        values.forEachIndexed { i, v ->
            val h = (v / max) * size.height * 0.92f
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
fun StatusPill(text: String, color: Color = Aqua) {
    Text(
        text,
        color = color,
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(color.copy(alpha = 0.14f))
            .padding(horizontal = 10.dp, vertical = 4.dp)
    )
}

/** Abschnittskarte mit Verlaufstitelbalken und freiem Inhalt. */
@Composable
fun SectionCard(title: String, content: @Composable () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(Surface2)
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .background(Brush.linearGradient(listOf(Color(0xFF7C6CFF).copy(alpha = 0.25f), Color(0xFF00E0B8).copy(alpha = 0.12f))))
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
        androidx.compose.foundation.layout.Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = MaterialTheme.typography.bodySmall, color = TextMuted)
            androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
            Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.height(2.dp))
        androidx.compose.foundation.layout.Box(
            Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(Border)
        )
    }
}
