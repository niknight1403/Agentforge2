package dev.villaforge.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.Shapes
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/*
 * VillaForge Professional Palette (v1.14.0): tiefe Nachtblau-Flaechen mit
 * drei Stufen, elektrischem Violett und Aqua als Akzente. Success/Warn/
 * Danger fuer Statusfarben, Border fuer feine Trennlinien.
 *
 * Neuerungen v1.14.0:
 * - Typografie-Hierarchie mit Display-Stil fuer Kennzahlen (tabellarische
 *   Ziffern, damit Werte beim Zaehlen nicht verbreitern).
 * - Overline-Stil fuer Sektions-Labels mit Letter-Spacing.
 * - statusColor(): semantische Statusfarben als zentrale Wahrheit.
 */
val Violet = Color(0xFFA39AE8)
val Aqua = Color(0xFF70D5CB)
val Ink = Color(0xFF0A1018)
val Surface1 = Color(0xFF131C28)
val Surface2 = Color(0xFF192433)
val Surface3 = Color(0xFF223044)
val TextMain = Color(0xFFF0F4FB)
val TextMuted = Color(0xFFADBACB)
val Warn = Color(0xFFFFC36D)
val Danger = Color(0xFFFF8290)
val Success = Color(0xFF70D6A5)
val Border = Color(0xFF344357)

/** Marken-Verlauf fuer Header und Highlights. */
val BrandGradient = Brush.linearGradient(listOf(Violet, Aqua))

/* Cyber-Neon-Palette (v1.31.0, Control-Center-Design): leuchtende Akzente
 * auf tiefem Nachtblau, Glas-Karten mit duennem Neon-Rand. */
val NeonCyan = Color(0xFF70D5CB)
val NeonPink = Color(0xFFD99DB9)
val ElectricBlue = Color(0xFF83B9E3)
val Glass = Color(0x1AFFFFFF)          // halbtransparentes Weiss fuer Glas-Flaechen
val NeonGradient = Brush.linearGradient(listOf(NeonCyan, NeonPink))
val CyanBlueGradient = Brush.linearGradient(listOf(NeonCyan, ElectricBlue))

/*
 * Quality-Layer v2 (2026-10-19, Nutzerdirektive: hochwertiger, exklusiver,
 * bedienungsfreundlich): Premium-Gold als exklusiver Zweitakzent neben dem
 * Cyber-Neon. Gold markiert Elite-/Unlimited-Status und verleiht Header,
 * Avatar-Ringen und Chips die exklusive Signatur.
 */
val Gold = Color(0xFFD7BD86)
val GoldBright = Color(0xFFF0E0B8)
val GoldGradient = Brush.linearGradient(listOf(Color(0xFFF0E0B8), Color(0xFFD7BD86), Color(0xFFAA8755)))
val PremiumInk = Color(0xFF0A1018)

/** Semantische Statusfarbe: zentrale Abbildung Villen-/Aufgaben-/Agentenzustaende. */
fun statusColor(status: String): Color = when {
    status == "RUNNING" || status == "läuft" -> Aqua
    status == "ARBEITET" -> Success
    status == "WARTET" || status == "QUEUED" -> Warn
    status == "DONE" || status == "COMPLETED" || status == "Key vorhanden" || status == "ok" -> Success
    status == "FAILED" || status == "BLOCKED" || status == "ERROR" -> Danger
    status == "PAUSED" || status == "PLANNING" || status == "STOPPING" ||
        status == "PENDING" || status == "kein Key" || status == "offline" -> Warn
    else -> TextMuted
}

private val scheme = darkColorScheme(
    primary = Violet,
    onPrimary = Ink,
    secondary = Aqua,
    onSecondary = Ink,
    tertiary = Success,
    background = Ink,
    onBackground = TextMain,
    surface = Surface1,
    onSurface = TextMain,
    surfaceVariant = Surface2,
    onSurfaceVariant = TextMuted,
    outline = Border,
    error = Danger
)

/*
 * Typografie-Hierarchie: Display fuer grosse Kennzahlen, Standard-Stile fuer
 * Titel und Text, Overline fuer Ordnungslabels. "tnum" = tabellarische
 * Ziffern: 1 und 8 gleich breit, Werte zappeln beim Animieren nicht.
 */
private val display = TextStyle(
    fontSize = 28.sp,
    fontWeight = FontWeight.Bold,
    color = TextMain,
    fontFeatureSettings = "tnum"
)

private val typography = Typography(
    displayLarge = display,
    displayMedium = display.copy(fontSize = 24.sp),
    headlineSmall = TextStyle(fontSize = 23.sp, fontWeight = FontWeight.Bold, color = TextMain),
    titleLarge = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold, color = TextMain),
    titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = TextMain),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp, color = TextMain),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 21.sp, color = TextMain),
    bodySmall = TextStyle(fontSize = 12.5.sp, color = TextMuted),
    labelSmall = TextStyle(
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 1.2.sp,
        color = TextMuted
    )
)

@Composable
fun VillaForgeTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = scheme,
        typography = typography,
        shapes = Shapes(small = RoundedCornerShape(10.dp), medium = RoundedCornerShape(16.dp), large = RoundedCornerShape(20.dp)),
        content = content
    )
}
