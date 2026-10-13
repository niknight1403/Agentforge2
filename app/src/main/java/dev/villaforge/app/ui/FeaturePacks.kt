package dev.villaforge.app.ui

/**
 * Feature Packs (v1.11.0): ab Werk aktivierte, in den Einstellungen
 * einzeln schaltbare Modulgruppen. Packs steuern, welche Bereiche das
 * Dashboard zeigt — der Hub liefert die Daten, die App entscheidet,
 * was sichtbar ist.
 */
data class FeaturePack(
    val id: String,
    val title: String,
    val desc: String
)

val FEATURE_PACKS = listOf(
    FeaturePack(
        "monitoring",
        "Monitoring Pack",
        "Hub-Gesundheit, Routen-Status und Live-Kennzahlen im Dashboard."
    ),
    FeaturePack(
        "analytics",
        "Analytics Pack",
        "Aufgaben- und Agenten-Fortschritt als Diagramm aufbereitet."
    ),
    FeaturePack(
        "council",
        "Rat der Agenten",
        "Agenten tauschen Erkenntnisse aus, optimieren die Villa gemeinsam und teilen Vorschlaege."
    ),
    FeaturePack(
        "product",
        "Produkt- & Marktreife-Pack",
        "Marktreife-Score als animierter Ring, Phasen-Fortschritt und Produktwellen je Villa im Detail-Screen."
    ),
    FeaturePack(
        "superintelligence",
        "Superintelligenz-Loop",
        "Der Hub beruft den Rat automatisch alle 2 Stunden ein — die Villa optimiert sich fortlaufend selbst."
    )
)
