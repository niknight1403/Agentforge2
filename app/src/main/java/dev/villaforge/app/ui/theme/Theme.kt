package dev.villaforge.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

val Violet = Color(0xFF6C5CE7)
val Aqua = Color(0xFF00D2A8)
val Ink = Color(0xFF070B16)
val Surface1 = Color(0xFF141B30)
val Surface2 = Color(0xFF1C243E)
val TextMain = Color(0xFFE8ECFF)
val TextMuted = Color(0xFF9AA6CC)
val Warn = Color(0xFFFFB020)
val Danger = Color(0xFFFF5F6D)

private val scheme = darkColorScheme(
    primary = Violet,
    onPrimary = Color.White,
    secondary = Aqua,
    onSecondary = Ink,
    background = Ink,
    onBackground = TextMain,
    surface = Surface1,
    onSurface = TextMain,
    surfaceVariant = Surface2,
    onSurfaceVariant = TextMuted,
    error = Danger
)

private val typography = Typography(
    headlineSmall = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = TextMain),
    titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = TextMain),
    bodyMedium = TextStyle(fontSize = 14.sp, color = TextMain),
    bodySmall = TextStyle(fontSize = 12.5.sp, color = TextMuted)
)

@Composable
fun VillaForgeTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, typography = typography, content = content)
}
