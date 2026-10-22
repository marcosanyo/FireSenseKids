plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.firesense.kids"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.firesense.kids.tv"
        minSdk = 22 // first-generation Fire TV (Fire OS 5) for early verification
        targetSdk = 30 // Fire OS 8 is based on Android 11 (API 30)
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        debug {
            isDebuggable = true
        }
        release {
            isMinifyEnabled = false
            // Sideload builds for the hackathon are signed with the debug key.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
    androidResources {
        // Keep the web bundle byte-identical (no compression of .wasm/.mp4/.js).
        noCompress += listOf("mp4", "js", "css", "html", "txt", "json", "woff2")
        // aapt's default pattern drops directories starting with "_" (<dir>_*), which would
        // silently strip Next.js's /_next/ chunks from the APK. Same defaults minus that rule.
        ignoreAssetsPattern = "!.svn:!.git:!.ds_store:!*.scc:.*:!CVS:!thumbs.db:!picasa.ini:!*~"
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}

// Fail fast: the APK is useless without the exported /tv bundle (scripts/package-tv-assets.sh).
val verifyWebAssets by tasks.registering {
    val index = file("src/main/assets/web/tv/index.html")
    doLast {
        if (!index.exists()) {
            throw GradleException(
                "Missing ${index.path}. Build the web app and run scripts/package-tv-assets.sh first."
            )
        }
    }
}
tasks.named("preBuild") { dependsOn(verifyWebAssets) }
