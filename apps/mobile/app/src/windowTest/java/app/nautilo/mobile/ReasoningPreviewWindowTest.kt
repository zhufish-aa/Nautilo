package app.nautilo.mobile

import android.app.Application
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import app.nautilo.mobile.data.ActivityItem
import app.nautilo.mobile.ui.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [35], qualifiers = "w393dp-h851dp-xhdpi")
class ReasoningPreviewWindowTest {
    @get:Rule val compose = createComposeRule()

    @Test fun collapsedLongLineFollowsItsEndAcrossChunksCompletionAndReopening() {
        val current = mutableStateOf(ActivityItem("thought", "thought", "思考", "Opening sentence. ".repeat(80) + "latest thought", true))
        compose.setContent {
            NautiloTheme {
                CompositionLocalProvider(LocalNautiloMotion provides false) {
                    Box(Modifier.width(280.dp)) { ProcessActivity(current.value) }
                }
            }
        }
        fun assertAtEnd() {
            compose.waitForIdle()
            val range = compose.onNodeWithTag("process-preview:thought", useUnmergedTree = true)
                .fetchSemanticsNode().config[SemanticsProperties.HorizontalScrollAxisRange]
            assertTrue("The preview should overflow this narrow phone row", range.maxValue() > 0f)
            assertEquals("Latest words must stay visible", range.maxValue(), range.value(), 1f)
        }
        assertAtEnd()
        compose.runOnUiThread { current.value = current.value.copy(detail = current.value.detail + " and the newly arrived words") }
        assertAtEnd()
        compose.runOnUiThread { current.value = current.value.copy(running = false) }
        assertAtEnd()
        compose.onNodeWithText("思考").performClick()
        compose.onNodeWithTag("process-preview:thought", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithText("思考").performClick()
        assertAtEnd()
    }
}
