plugins {
    id("com.android.application") version "9.5.0" apply false
    // AGP 9 bringt Kotlin-Support selbst mit (built-in Kotlin), das Plugin
    // "org.jetbrains.kotlin.android" darf nicht mehr angewendet werden.
    // Der Compose-Compiler kommt weiterhin aus dem Compose-Plugin.
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
}
