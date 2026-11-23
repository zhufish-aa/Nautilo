import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val screenshotRendering = providers.gradleProperty("nautiloScreenshots").orNull == "true"
val windowTesting = providers.gradleProperty("nautiloWindowTests").orNull == "true"
if (screenshotRendering) apply(plugin = "app.cash.paparazzi")

val transportRoot = file("${System.getenv("NAUTILO_ANDROID_BUILD_DIR") ?: "${rootProject.rootDir}/build"}/transport")
val nativeTransport = tasks.register<Exec>("prepareNativeTransport") {
    commandLine(System.getenv("NAUTILO_TEST_NODE") ?: "node", rootProject.file("../../scripts/build-mobile-transport.mjs").absolutePath)
    inputs.dir(rootProject.file("native/iroh-kmp"))
    inputs.dir(rootProject.file("../../rust/patches"))
    inputs.file(rootProject.file("../../scripts/prepare-rust-sources.mjs"))
    inputs.file(rootProject.file("../../scripts/build-mobile-transport.mjs"))
    outputs.file(File(transportRoot, "iroh-kmp-nautilo.aar"))
    outputs.file(File(transportRoot, "build.json"))
}

android {
    namespace = "app.nautilo.mobile"
    compileSdk = 35
    defaultConfig {
        applicationId = "app.nautilo.mobile"
        minSdk = 26
        targetSdk = 35
        versionCode = 26
        versionName = "0.1.25"
        manifestPlaceholders["appLabel"] = "Nautilo"
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    val signingFile = System.getenv("NAUTILO_ANDROID_SIGNING")?.let(::file)
    if (signingFile != null && signingFile.exists()) {
        val values = Properties().apply { signingFile.inputStream().use(::load) }
        signingConfigs.create("localRelease") {
            storeFile = file(values.getProperty("storeFile"))
            storePassword = values.getProperty("storePassword")
            keyAlias = values.getProperty("keyAlias")
            keyPassword = values.getProperty("keyPassword")
        }
        buildTypes.getByName("release").signingConfig = signingConfigs.getByName("localRelease")
    }
    buildTypes {
        debug {
            // A separate package lets camera fixes be tested without replacing
            // an installed release or requiring its private signing key.
            if (project.findProperty("nautiloScanTest") == "true") {
                applicationIdSuffix = ".scanfix"
                versionNameSuffix = "-scanfix"
                manifestPlaceholders["appLabel"] = "Nautilo 验证版"
            }
        }
        release {
            isMinifyEnabled = false
            isDebuggable = false
        }
    }
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
        // Both dependencies package a JNA dispatch library; package one per ABI.
        jniLibs.pickFirsts += "**/libjnidispatch.so"
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
        unitTests.isIncludeAndroidResources = windowTesting
        unitTests.all {
            it.maxHeapSize = "1024m"
            val testHome = file("${System.getenv("ANDROID_USER_HOME") ?: rootProject.layout.buildDirectory.get().asFile}/window-tests")
            it.systemProperty("user.home", testHome.absolutePath)
            it.doFirst { testHome.mkdirs() }
            it.systemProperty("robolectric.dependency.repo.url", "https://repo.maven.apache.org/maven2")
        }
    }
    if (screenshotRendering) sourceSets.getByName("test").java.srcDir("src/screenshotTest/java")
    if (windowTesting) sourceSets.getByName("test").java.srcDir("src/windowTest/java")
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.02.00"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation(files(File(transportRoot, "iroh-kmp-nautilo.aar")).builtBy(nativeTransport))
    implementation("net.java.dev.jna:jna:5.18.1@aar")
    implementation("org.jetbrains.kotlinx:atomicfu:0.26.1")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    // Embedded 4.3 defaults to the older 3.4.1 detector. Keep the camera
    // integration, with the current QR detector for dense and rotated codes.
    implementation("com.google.zxing:core:3.5.4")
    implementation("io.noties.markwon:core:4.6.2")
    implementation("io.noties.markwon:ext-tables:4.6.2")
    implementation("io.noties.markwon:ext-strikethrough:4.6.2")
    implementation("dev.snipme:highlights:1.0.0")
    implementation("io.github.java-diff-utils:java-diff-utils:4.15")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation(platform("androidx.compose:compose-bom:2025.02.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    if (screenshotRendering) testImplementation("org.mockito:mockito-core:5.15.2")
    if (windowTesting) {
        testImplementation("org.robolectric:robolectric:4.14.1")
        testImplementation("androidx.compose.ui:ui-test-junit4")
        testImplementation("org.mockito:mockito-core:5.15.2")
    }
}
