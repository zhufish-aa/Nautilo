package app.nautilo.mobile

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import app.nautilo.mobile.data.*
import app.nautilo.mobile.ui.*
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.Assume.assumeTrue
import java.io.File

class ConfigurationSheetTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    @Test fun actionsStayVisibleOnShortScreenWithLargeTextWhileOptionsScroll() {
        val app = ApplicationProvider.getApplicationContext<NautiloApplication>()
        val model = MobileViewModel(app)
        val state = MobileState(connected = true, session = Conversation("fixture", "project", "设置", "idle", "", "model-0", "low"),
            models = (0..20).map { json("id" to "model-$it", "displayName" to "模型 $it",
                "reasoningEfforts" to org.json.JSONArray(listOf("low", "medium", "high", "xhigh", "max"))) })
        var closed = false
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 1.4f)) {
                NautiloTheme {
                    SessionConfigurationSheet(state, model) { closed = true }
                }
            }
        }
        compose.onNodeWithTag("session-config-cancel").assertIsDisplayed()
        compose.onNodeWithTag("session-config-apply").assertIsDisplayed()
        compose.onNodeWithTag("config-model-picker").performClick()
        compose.onNodeWithTag("creation-choice-list").performScrollToNode(hasText("模型 20"))
        compose.onNodeWithContentDescription("返回设置").performClick()
        compose.onNodeWithText("推理强度").performScrollTo()
        compose.onNodeWithTag("session-config-apply").assertIsDisplayed()
        compose.onNodeWithTag("session-config-cancel").performTouchInput { click() }
        assertTrue(closed)
    }

    @Test fun captureConfigurationInBothThemes() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("captureNautiloDesign") == "true")
        val app = ApplicationProvider.getApplicationContext<NautiloApplication>()
        val model = MobileViewModel(app)
        val dark = mutableStateOf(false)
        val transparent = android.graphics.Color.TRANSPARENT
        compose.runOnUiThread {
            compose.activity.enableEdgeToEdge(SystemBarStyle.auto(transparent, transparent), SystemBarStyle.auto(transparent, transparent))
        }
        val state = MobileState(connected = true, screen = Screen.NewConversation, latency = 28,
            projects = listOf(Project("project", "Nautilo")),
            host = Host("pc", "Nautilo PC", json()),
            session = Conversation("fixture", "project", "回归测试", "idle", "", "gpt-6-luna", "max", agentId = "codex", connectionId = "account"),
            setup = json(
                "agents" to org.json.JSONArray().put(json("id" to "codex", "name" to "Codex")),
                "connections" to org.json.JSONArray().put(json("id" to "account", "name" to "Codex 账号 2")),
            ),
            newModels = listOf(
                json("id" to "gpt-6-luna", "displayName" to "GPT-6-Luna",
                    "reasoningEfforts" to org.json.JSONArray(listOf("low", "medium", "high", "xhigh", "max")),
                    "defaultReasoningEffort" to "max"),
                json("id" to "gpt-6.1-sol", "displayName" to "GPT-6.1 Sol"),
                json("id" to "gpt-6.2", "displayName" to "GPT-6.2"),
                json("id" to "gpt-6.2-astra", "displayName" to "GPT-6.2 Astra"),
                json("id" to "gpt-6.1-terra", "displayName" to "GPT-6.1 Terra"),
                json("id" to "gpt-6-astra", "displayName" to "GPT-6 Astra"),
                json("id" to "gpt-6-sol", "displayName" to "GPT-6 Sol"),
            ))
        compose.setContent {
            NautiloTheme(dark.value) {
                Box(Modifier.fillMaxSize().background(Backdrop).statusBarsPadding().navigationBarsPadding()) {
                    NewConversationScreen(state, model)
                }
            }
        }
        compose.onNodeWithTag("starter-engine").performClick()
        fun capture(name: String) {
            compose.waitForIdle()
            val picture = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
            File(app.filesDir, name).outputStream().use { assertTrue(picture.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        }
        for (night in listOf(false, true)) {
            compose.runOnIdle {
                dark.value = night
                val window = compose.activity.window
                val bars = androidx.core.view.WindowCompat.getInsetsController(window, window.decorView)
                bars.isAppearanceLightStatusBars = !night
                bars.isAppearanceLightNavigationBars = !night
            }
            compose.onNodeWithTag("sheet-grab-handle").assertIsDisplayed()
            compose.onNodeWithTag("new-config-apply").assertIsDisplayed()
            val theme = if (night) "dark" else "light"
            capture("settings-$theme.png")
            compose.onNodeWithTag("config-model-picker").performClick()
            compose.onNodeWithTag("creation-choice-list").assertIsDisplayed()
            compose.onNodeWithText("GPT-6.2 Astra").assertIsDisplayed()
            capture("model-picker-$theme.png")
            compose.onNodeWithContentDescription("返回设置").performClick()
        }
    }
}
