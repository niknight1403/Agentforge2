plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Production signing is supplied only through protected CI environment variables.
val releaseStorePath = System.getenv("ANDROID_RELEASE_KEYSTORE_PATH")
val releaseStorePassword = System.getenv("ANDROID_RELEASE_KEYSTORE_PASSWORD")
val releaseKeyAlias = System.getenv("ANDROID_RELEASE_KEY_ALIAS")
val releaseKeyPassword = System.getenv("ANDROID_RELEASE_KEY_PASSWORD")
val hasReleaseSigning = listOf(releaseStorePath, releaseStorePassword, releaseKeyAlias, releaseKeyPassword)
    .all { !it.isNullOrBlank() }
val allowDebugSigning = providers.gradleProperty("allowDebugSigning").orNull == "true"

android {
    namespace = "dev.villaforge.app"
    // okhttp-android 5.x verlangt mindestens API 37 zum Kompilieren.
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.villaforge.app"
        minSdk = 26
        targetSdk = 37
        versionCode = 81
        versionName = "1.66.0"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseStorePath!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            // Production builds must use TLS; cleartext is limited to local debug setups.
            manifestPlaceholders["usesCleartextTraffic"] = "false"
            // Optimierter Release-Build: R8 verkleinert+verschleiert, Ressourcen werden
            // gestrippt. Production uses the protected release keystore; PR QA may
            // explicitly opt into a debug signature via -PallowDebugSigning=true.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = if (hasReleaseSigning) signingConfigs.getByName("release")
                else signingConfigs.getByName("debug")
        }
        debug {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
    }
    packaging {
        resources.excludes += setOf(
            "/META-INF/{AL2.0,LGPL2.1}",
            "/META-INF/DEPENDENCIES",
            "/META-INF/INDEX.LIST"
        )
    }
}

// A release task must never silently publish an APK signed with the debug key.
val validateReleaseSigning = tasks.register("validateReleaseSigning") {
    doLast {
        if (!hasReleaseSigning && !allowDebugSigning) {
            throw GradleException(
                "Release signing is not configured. Set ANDROID_RELEASE_KEYSTORE_PATH, " +
                    "ANDROID_RELEASE_KEYSTORE_PASSWORD, ANDROID_RELEASE_KEY_ALIAS and " +
                    "ANDROID_RELEASE_KEY_PASSWORD in the protected build environment. " +
                    "For PR-only QA builds, explicitly pass -PallowDebugSigning=true."
            )
        }
    }
}
tasks.configureEach {
    if (name == "assembleRelease" || name == "bundleRelease") {
        dependsOn(validateReleaseSigning)
    }
}

// Kotlin 1.8+ includes JDK 7/8 extensions in kotlin-stdlib itself.
// Exclude obsolete split artifacts requested by older AndroidX metadata.
configurations.configureEach {
    exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib-jdk7")
    exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib-jdk8")
}

dependencies {
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("io.coil-kt:coil-compose:2.7.0")
    implementation("androidx.appcompat:appcompat:1.8.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.4")
    implementation("androidx.activity:activity-compose:1.9.1")

    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.1")

    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
