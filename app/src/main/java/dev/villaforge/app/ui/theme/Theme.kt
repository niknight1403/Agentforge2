package dev.villaforge.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/*
 * VillaForge Professional Palette (v1.11.0): tiefe Nachtblau-Flaechen mit
 * drei Stufen, elektrischem Violett und Aqua als Akzente. Success/Warn/
 * Danger fuer Statusfarben, Border fuer feine Trennlinien.
 */
val Violet = Color(0xFF7C6CFF)
val Aqua = Color(0xFF00E0B8)
val Ink = Color(0xFF05070F)
val Surface1 = Color(0xFF10182C)
val Surface2 = Color(0xFF18223C)
val Surface3 = Color(0xFF212D4E)
val TextMain = Color(0xFFECF0FF)
val TextMuted = Color(0xFF94A0C8)
val Warn = Color(0xFFFFB020)
val Danger = Color(0xFFFF5F6D)
val Success = Color(0xFF35D97B)
val Border = Color(0xFF2A3654)

/** Marken-Verlauf fuer Header und Highlights. */
val BrandGradient = Brush.linearGradient(listOf(Violet, Aqua))

private val scheme = darkColorScheme(
    primary = Violet,
    onPrimary = Color.White,
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

private val typography = Typography(
    headlineSmall = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.Bold, color = TextMain),
    titleLarge = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold, color = TextMain),
    titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = TextMain),
    bodyLarge = TextStyle(fontSize = 15.sp, color = TextMain),
    bodyMedium = TextStyle(fontSize = 14.sp, color = TextMain),
    bodySmall = TextStyle(fontSize = 12.5.sp, color = TextMuted)
)

@Composable
fun VillaForgeTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, typography = typography, content = content)
}
