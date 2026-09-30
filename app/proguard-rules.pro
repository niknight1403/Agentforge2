# Keep Room generated code and Kotlin serialization.
-keep class dev.villaforge.app.data.** { *; }
-keepclassmembers class * {
    @androidx.room.* <methods>;
}
-dontwarn okhttp3.**
-dontwarn okio.**
