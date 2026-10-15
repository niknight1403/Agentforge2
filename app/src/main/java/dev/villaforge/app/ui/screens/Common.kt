package dev.villaforge.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.villaforge.app.net.VillaEvent
import dev.villaforge.app.ui.theme.Aqua
import dev.villaforge.app.ui.theme.Danger
import dev.villaforge.app.ui.theme.Surface1
import dev.villaforge.app.ui.theme.Surface2
import dev.villaforge.app.ui.theme.TextMain
import dev.villaforge.app.ui.theme.TextMuted
import androidx.compose.ui.graphics.Brush
import dev.villaforge.app.ui.theme.statusColor
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/*
 * Geteilte Bausteine aller Screens (v1.14.0): Karten, Badges, Kennzahlen,
 * Sektionen, Zeitformat. Internal statt private, weil die Screens seit dem
 * Monolith-Aufbruch in eigenen Dateien leben.
 */

@Composable
internal fun muted() = MaterialTheme.typography.bodySmall

@Composable
internal fun ErrorBanner(text: String, onRetry: (() -> Unit)? = null) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(dev.villaforge.app.ui.theme.Danger.copy(alpha = 0.14f), RoundedCornerShape(10.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text,
            color = dev.villaforge.app.ui.theme.Danger,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(1f)
        )
        if (onRetry != null) {
            TextButton(onClick = onRetry) { Text("Erneut versuchen") }
        }
    }
}

@Composable
internal fun Card(title: String, subtitle: String, badge: String, onClick: (() -> Unit)? = null, content: @Composable () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .clip(RoundedCornerShape(18.dp))
            .border(0.9.dp, Brush.linearGradient(listOf(dev.villaforge.app.ui.theme.NeonCyan.copy(alpha = 0.38f), dev.villaforge.app.ui.theme.NeonPink.copy(alpha = 0.24f))), RoundedCornerShape(18.dp))
            .background(Surface2.copy(alpha = 0.88f))
            .padding(14.dp)
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(title, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Badge(badge)
        }
        if (subtitle.isNotBlank()) {
            Spacer(Modifier.height(4.dp))
            Text(subtitle, style = muted(), color = TextMuted)
        }
        Spacer(Modifier.height(10.dp))
        content()
    }
}

@Composable
internal fun RowCard(title: String, subtitle: String, badge: String, trailing: (@Composable () -> Unit)? = null) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .border(0.7.dp, Brush.linearGradient(listOf(dev.villaforge.app.ui.theme.NeonCyan.copy(alpha = 0.26f), dev.villaforge.app.ui.theme.NeonPink.copy(alpha = 0.16f))), RoundedCornerShape(16.dp))
            .background(Surface2.copy(alpha = 0.86f))
            .padding(12.dp)
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(title, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            if (trailing != null) trailing() else Badge(badge)
        }
        if (subtitle.isNotBlank()) {
            Spacer(Modifier.height(4.dp))
            Text(subtitle, style = muted(), color = TextMuted)
        }
    }
}

@Composable
internal fun Badge(text: String) {
    val color = statusColor(text)
    Row(
        Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(color.copy(alpha = 0.16f))
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(color))
        Spacer(Modifier.width(6.dp))
        Text(text, style = muted(), color = color)
    }
}

@Composable
internal fun Stat(label: String, value: String) {
    Column(
        Modifier.clip(RoundedCornerShape(12.dp)).background(Surface2).padding(horizontal = 12.dp, vertical = 8.dp)
    ) {
        Text(value, fontWeight = FontWeight.Bold)
        Text(label, style = muted(), color = TextMuted)
    }
}

@Composable
internal fun Section(title: String, content: @Composable () -> Unit) {
    Spacer(Modifier.height(16.dp))
    Text(title, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(6.dp))
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) { content() }
}

/** Kleiner Puls-Punkt: Aqua verbunden, grau getrennt (SSE-Status). */
@Composable
internal fun LiveDot(connected: Boolean) {
    val color = if (connected) Aqua else TextMuted
    Box(Modifier.size(8.dp).clip(CircleShape).background(color))
}

/** Eine Zeile im Live-Ereignis-Feed (SSE-Ticker). */
@Composable
internal fun EventRow(event: VillaEvent) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(Surface2)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(event.type, color = Aqua, style = muted(), fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.width(10.dp))
        Text(event.text, style = muted(), modifier = Modifier.weight(1f), color = TextMain)
        Spacer(Modifier.width(8.dp))
        Text(time(event.ts), style = muted(), color = TextMuted)
    }
}

internal fun time(ts: Long): String =
    SimpleDateFormat("HH:mm", Locale.GERMANY).format(Date(if (ts > 0) ts else System.currentTimeMillis()))
