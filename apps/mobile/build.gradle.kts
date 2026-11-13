plugins {
    id("com.android.application") version "8.8.2" apply false
    id("org.jetbrains.kotlin.android") version "2.1.10" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.10" apply false
}
allprojects {
    layout.buildDirectory.set(file("${System.getenv("NAUTILO_ANDROID_BUILD_DIR") ?: "${rootDir}/build"}/${project.name}"))
}
