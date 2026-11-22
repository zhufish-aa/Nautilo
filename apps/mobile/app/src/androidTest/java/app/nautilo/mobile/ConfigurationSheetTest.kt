package app.nautilo.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import app.nautilo.mobile.data.*
import app.nautilo.mobile.ui.*
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ConfigurationSheetTest {
    @get:Rule val compose = createComposeRule()
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
        compose.onNodeWithText("模型", substring = false).performClick()
        compose.onNodeWithTag("creation-choice-list").performScrollToNode(hasText("模型 20"))
        compose.onNodeWithContentDescription("返回设置").performClick()
        compose.onNodeWithText("推理强度").performScrollTo()
        compose.onNodeWithTag("session-config-apply").assertIsDisplayed()
        compose.onNodeWithTag("session-config-cancel").performTouchInput { click() }
        assertTrue(closed)
    }
}
