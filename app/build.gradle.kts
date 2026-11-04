plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.syncspeaker.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.syncspeaker.app"
        // Android 10: the first version with AudioPlaybackCapture.
        minSdk = 29
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        // A fixed, public debug key (committed on purpose) so that every CI build is
        // signed with the same key and you can install a newer APK over an older one.
        // It is NOT a secret and must never be used for a Play Store release.
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("debug")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    sourceSets {
        getByName("main") {
            // The listener web page lives in /web/listener and is shared with the
            // PC host server (/server). It is packaged into the APK as assets.
            assets.srcDirs("src/main/assets", "../web/listener")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        abortOnError = false
    }

}

dependencies {
    // Embedded HTTP + WebSocket server (tiny, pure Java, no other dependencies).
    implementation("org.nanohttpd:nanohttpd-websocket:2.3.1")
    // QR code generation.
    implementation("com.google.zxing:core:3.5.3")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:okhttp:4.12.0")
}
