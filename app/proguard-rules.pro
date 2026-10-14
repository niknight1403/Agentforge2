# VillaForge Release-Regeln (R8)
# OkHttp: Plattform-Klassen sind optional, Warnungen unterdruecken
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
# Coroutine-Debugger intern: nicht noetig im Release
-dontwarn kotlinx.coroutines.debug.**
# Coil laedt Implementierungen reflektiv (OkHttp-Factories sind per Regel abgedeckt)
-keep class coil.decode.** { *; }
