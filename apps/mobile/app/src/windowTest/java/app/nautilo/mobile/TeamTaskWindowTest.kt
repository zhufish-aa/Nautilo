package app.nautilo.mobile

import android.app.Application
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.material3.Icon
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowBack
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.data.*
import app.nautilo.mobile.ui.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [35], qualifiers = "w393dp-h851dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TeamTaskWindowTest {
    @get:Rule val compose = createComposeRule()
    private val members = listOf(MobileTeamMember("explore", "项目探索者", "Codex", "codex"),
        MobileTeamMember("ui", "界面工程师", "Claude Code", "claude-code", status = "running"),
        MobileTeamMember("dev", "开发工程师", "DeepSeek Harness", "deepseek", status = "running"))
    private val snapshot = TeamTaskSnapshot("root", "Nautilo", MobileTeam("team", "研发团队", "autonomous", members),
        "run", "完善移动端体验", "executing", startedAt = java.time.Instant.now().minusSeconds(222).toString(), tasks = listOf(
            TeamTask("analysis", "梳理交互与状态", "completed", memberId = "explore", memberName = "项目探索者", harness = "Codex", summary = "已确认 6 处需要优化"),
            TeamTask("ui", "统一页面与组件", "running", listOf("analysis"), "ui", "界面工程师", "Claude Code", "child-ui", activityName = "edit_file",
                activityInput = "{\"file_path\":\"ChatComposer.kt\"}", fileCount = 2, additions = 28, deletions = 6),
            TeamTask("events", "接入团队任务状态", "running", listOf("analysis"), "dev", "开发工程师", "DeepSeek Harness", "child-dev", activityName = "pwsh",
                activityInput = "{\"description\":\"验证事件同步\"}", fileCount = 3, additions = 42, deletions = 8),
            TeamTask("verify", "验证完整会话流程", "blocked_dependency", listOf("ui", "events"), "explore", "项目探索者", "Codex")).mapIndexed { index, task -> task.copy(createdAt = "2026-11-16T00:00:0${index}Z") }, members = members)

    @Test fun parallelCardsKeepTheFooterVisibleAndOpenTheCorrectChild() {
        var opened = ""; var stopped = false; var returned = false
        compose.setContent { NautiloTheme { CompositionLocalProvider(LocalNautiloMotion provides false) {
            Box(Modifier.fillMaxSize()) { TeamTaskContent(snapshot, "", back = { returned = true }, refresh = {}, stop = { stopped = true }, open = { opened = it.sessionId }) }
        } } }
        compose.onNodeWithText("1 / 4 已完成").assertIsDisplayed()
        compose.onNodeWithTag("parallel:ui:events").assertExists()
        compose.onNodeWithText("统一页面与组件").performClick()
        assertEquals("child-ui", opened)
        compose.onNodeWithTag("team-task-list").performScrollToNode(hasTestTag("team-task:verify"))
        compose.onNodeWithText("等待 2 个并行任务完成").assertIsDisplayed()
        compose.onNodeWithTag("team-return-chat").assertIsDisplayed().performClick()
        assertTrue(returned)
        compose.onNodeWithTag("team-stop").assertIsDisplayed().performClick()
        assertTrue(stopped)
        compose.onNodeWithText("成员 3").performClick()
        compose.onNodeWithText("界面工程师").assertIsDisplayed()
    }

    @Test fun teamSelectionCanStageACollaborationOrReturnToSolo() {
        var chosen: String? = null
        val state = MobileState(setup = json("teams" to org.json.JSONArray(listOf(json("id" to "team", "name" to "研发团队",
            "delegationPolicy" to "autonomous", "members" to org.json.JSONArray(listOf(json("id" to "dev", "name" to "开发工程师"))))))))
        compose.setContent { NautiloTheme { TeamChoiceContent(state, "", {}, {}, { chosen = it }) } }
        compose.onNodeWithText("研发团队").performClick()
        assertEquals("team", chosen)
        compose.onNodeWithText("独立工作").performClick()
        assertEquals("", chosen)
    }

    @Test fun renderApprovedParallelLayout() {
        var renderedView: android.view.View? = null
        compose.setContent { NautiloTheme { CompositionLocalProvider(LocalNautiloMotion provides false) {
            val view = LocalView.current
            SideEffect { renderedView = view }
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    ActionIcon(Icons.Outlined.ArrowBack, "返回", click = {})
                    Text("团队任务", Modifier.weight(1f).padding(start = 4.dp), fontSize = 23.sp, fontWeight = FontWeight.SemiBold)
                    ActionIcon(Icons.Outlined.MoreVert, "更多", click = {})
                }
                TeamTaskContent(snapshot, "", back = {}, refresh = {}, stop = {}, open = {})
            }
        } } }
        compose.onNodeWithTag("team-return-chat").assertIsDisplayed()
        val file = File("D:/CodexBuildCache/Nautilo/mobile/artifacts/team-tasks-preview.png")
        file.parentFile?.mkdirs()
        compose.runOnUiThread {
            val view = requireNotNull(renderedView).rootView
            val bitmap = android.graphics.Bitmap.createBitmap(view.width, view.height, android.graphics.Bitmap.Config.ARGB_8888)
            view.draw(android.graphics.Canvas(bitmap))
            file.outputStream().use { stream -> bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream) }
            bitmap.recycle()
        }
    }
}
