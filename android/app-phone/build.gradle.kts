plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 版本号统一来自 gradle.properties（与 TV 版共用）
val appVersionCode: Int = (findProperty("appVersionCode") as String? ?: "1").toInt()
val appVersionName: String = findProperty("appVersionName") as String? ?: "1.0.0"

android {
    namespace = "com.example.tvwallpaper.phone"
    compileSdk = 34

    defaultConfig {
        // 独立 applicationId，可与 TV 版共存于同一设备
        applicationId = "com.example.tvwallpaper.phone"
        minSdk = 21
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersionName
    }

    signingConfigs {
        create("release") {
            val ksPropsFile = rootProject.file("keystore.properties")
            if (ksPropsFile.exists()) {
                val p = ksPropsFile.readText()
                    .lineSequence()
                    .map { it.trim() }
                    .filter { it.isNotEmpty() && !it.startsWith("#") && it.contains("=") }
                    .associate { val (k, v) = it.split("=", limit = 2); k.trim() to v.trim() }
                storeFile = rootProject.file(p["storeFile"] ?: "release-keystore.jks")
                storePassword = p["storePassword"]
                keyAlias = p["keyAlias"]
                keyPassword = p["keyPassword"]
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            val rc = signingConfigs.findByName("release")
            if (rc?.storeFile != null) {
                signingConfig = rc
            }
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
        viewBinding = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
