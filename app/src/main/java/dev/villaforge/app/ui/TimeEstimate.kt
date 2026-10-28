package dev.villaforge.app.ui

/** Compact, readable ETA label. Very large projections are shown as a range. */
fun formatEta(minutes: Int, capped: Boolean = false): String = when {
    capped -> "> 24 Std"
    minutes <= 0 -> "ETA wird ermittelt"
    minutes < 60 -> "≈ $minutes Min"
    else -> "≈ ${minutes / 60} Std${if (minutes % 60 >= 30) " ${minutes % 60} Min" else ""}"
}
