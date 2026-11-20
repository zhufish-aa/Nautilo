package app.nautilo.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.data.*
import org.json.JSONObject

@Composable internal fun TeamTaskTimeline(snapshot: TeamTaskSnapshot, open: (TeamTask) -> Unit, retry: ((TeamTask) -> Unit)? = null) {
    val stages = remember(snapshot.tasks) { teamTaskStages(snapshot.tasks) }
    LazyColumn(Modifier.fillMaxSize().testTag("team-task-list"), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 16.dp)) {
        if (stages.isEmpty()) item("empty") { EmptyView(Icons.Outlined.AccountTree, "尚未派发任务") }
        stages.forEachIndexed { index, stage ->
            item("stage:${stage.tasks.first().id}") {
                Column {
                    when {
                        stage.parallel -> {
                            StageJunction(true, "并行执行 · ${stage.tasks.size} 个任务")
                            ParallelTasks(stage.tasks, snapshot.tasks, open, retry)
                            if (index < stages.lastIndex) StageJunction(false)
                        }
                        stage.unresolved -> {
                            Text("依赖关系待确认", fontSize = 12.sp, color = TeamSecondary, modifier = Modifier.padding(start = 32.dp, bottom = 9.dp))
                            stage.tasks.forEach { TaskOnRail(it, snapshot.tasks, open, retry, connected = false) }
                        }
                        else -> TaskOnRail(stage.tasks.first(), snapshot.tasks, open, retry, index < stages.lastIndex)
                    }
                }
            }
        }
    }
}

@Composable private fun TaskOnRail(task: TeamTask, tasks: List<TeamTask>, open: (TeamTask) -> Unit, retry: ((TeamTask) -> Unit)?, connected: Boolean) {
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
        Box(Modifier.width(26.dp).fillMaxHeight().drawBehind {
            if (connected) drawLine(TeamLine, Offset(12.dp.toPx(), 30.dp.toPx()), Offset(12.dp.toPx(), size.height), 1.dp.toPx())
        }, contentAlignment = Alignment.TopCenter) { TaskMarker(task, Modifier.padding(top = 11.dp)) }
        Box(Modifier.weight(1f).padding(start = 6.dp, bottom = 9.dp)) { TeamTaskCard(task, tasks, open, retry) }
    }
}

/** Parallel siblings attach to one bracket, never to a child-to-child arrow. */
@Composable private fun ParallelTasks(parallel: List<TeamTask>, tasks: List<TeamTask>, open: (TeamTask) -> Unit, retry: ((TeamTask) -> Unit)?) {
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).testTag("parallel:${parallel.joinToString(":") { it.id }}")) {
        Box(Modifier.width(26.dp).fillMaxHeight().drawBehind {
            drawLine(TeamLine, Offset(12.dp.toPx(), 0f), Offset(12.dp.toPx(), size.height), 1.dp.toPx())
        })
        val centers = remember(parallel.map { it.id }) { mutableStateMapOf<String, Float>() }
        val density = LocalDensity.current
        Column(Modifier.weight(1f).padding(start = 6.dp).background(Color(0xFFF4F4F2), RoundedCornerShape(14.dp))
            .border(.6.dp, Color(0xFFE4E4E1), RoundedCornerShape(14.dp)).padding(8.dp)
            .drawBehind {
                val points = parallel.mapNotNull { centers[it.id] }
                if (points.isNotEmpty()) {
                    val x = 3.dp.toPx()
                    drawLine(Color(0xFFB7B7B4), Offset(x, points.first()), Offset(x, points.last()), 1.dp.toPx())
                    points.forEach { y -> drawLine(Color(0xFFB7B7B4), Offset(x, y), Offset(17.dp.toPx(), y), 1.dp.toPx()) }
                }
            }, verticalArrangement = Arrangement.spacedBy(9.dp)) {
            parallel.forEach { task ->
                Row(Modifier.fillMaxWidth().onGloballyPositioned { centers[task.id] = it.positionInParent().y + with(density) { 18.dp.toPx() } },
                    horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    Box(Modifier.width(25.dp).padding(start = 14.dp, top = 9.dp)) { TaskMarker(task) }
                    Box(Modifier.weight(1f)) { TeamTaskCard(task, tasks, open, retry) }
                }
            }
        }
    }
}

@Composable private fun StageJunction(fork: Boolean, label: String? = null) {
    Row(Modifier.fillMaxWidth().height(if (label == null) 22.dp else 25.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Canvas(Modifier.width(26.dp).fillMaxHeight()) {
            val x = 12.dp.toPx(); val y = size.height / 2; val radius = 11.dp.toPx()
            drawLine(TeamLine, Offset(x, 0f), Offset(x, size.height), 1.dp.toPx())
            drawCircle(Color(0xFFECECE9), radius, Offset(x, y))
            val p = Path().apply {
                if (fork) { moveTo(x, y - 5.dp.toPx()); lineTo(x, y); lineTo(x - 5.dp.toPx(), y + 5.dp.toPx()); moveTo(x, y); lineTo(x + 5.dp.toPx(), y + 5.dp.toPx()) }
                else { moveTo(x - 5.dp.toPx(), y - 5.dp.toPx()); lineTo(x, y); lineTo(x, y + 5.dp.toPx()); moveTo(x + 5.dp.toPx(), y - 5.dp.toPx()); lineTo(x, y) }
            }
            drawPath(p, TeamText, style = Stroke(1.4.dp.toPx(), cap = StrokeCap.Round))
        }
        label?.let { Text(it, fontSize = 12.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium, color = TeamSecondary,
            modifier = Modifier.background(Color(0xFFEEEEEB), CircleShape).padding(horizontal = 11.dp, vertical = 3.dp)) }
    }
}

@Composable private fun TaskMarker(task: TeamTask, modifier: Modifier = Modifier) {
    Box(modifier.size(18.dp), contentAlignment = Alignment.Center) {
        when {
            task.completed -> Box(Modifier.fillMaxSize().background(Color(0xFF218331), CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.Check, null, Modifier.size(14.dp), tint = Color.White)
            }
            task.status == "failed" -> Icon(Icons.Outlined.ErrorOutline, "执行失败", Modifier.fillMaxSize(), tint = Danger)
            task.status == "cancelled" -> Icon(Icons.Outlined.StopCircle, "已停止", Modifier.fillMaxSize(), tint = TeamSecondary)
            task.waiting -> Icon(Icons.Outlined.PauseCircleOutline, teamTaskStatus(task.status), Modifier.fillMaxSize(), tint = TeamSecondary)
            task.executing -> {
                Canvas(Modifier.fillMaxSize()) { drawCircle(Color(0xFFE0E0DD), style = Stroke(2.5.dp.toPx())) }
                NSpinner(Modifier.fillMaxSize(), strokeWidth = 2.5.dp, color = TeamText)
            }
            else -> Box(Modifier.size(16.dp).border(1.4.dp, Color(0xFF92928E), CircleShape))
        }
    }
}

@Composable private fun TeamTaskCard(task: TeamTask, tasks: List<TeamTask>, open: (TeamTask) -> Unit, retry: ((TeamTask) -> Unit)?) {
    val subject = listOf(task.memberName, task.harness).filter(String::isNotBlank).joinToString(" · ").ifBlank { "待分配" }
    NPanel(onClick = if (task.sessionId.isNotEmpty()) ({ open(task) }) else null,
        color = TeamCanvas, shape = RoundedCornerShape(12.dp), border = BorderStroke(.7.dp, Color(0xFFD2D2D0)),
        modifier = Modifier.fillMaxWidth().testTag("team-task:${task.id}")) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 11.dp, vertical = 7.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(task.title, fontSize = 16.sp, lineHeight = 21.sp, fontWeight = FontWeight.SemiBold, color = TeamText)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                Icon(Icons.Outlined.PersonOutline, null, Modifier.size(15.dp), tint = TeamText)
                Text(subject, fontSize = 12.sp, lineHeight = 17.sp, color = TeamText, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (task.completed && task.summary.isNotBlank()) Text(task.summary, fontSize = 12.sp, lineHeight = 17.sp, color = TeamSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            else if (!task.completed) {
                val pending = task.dependencies.any { dependency -> tasks.none { it.id == dependency && it.completed } }
                if (task.activityName.isNotBlank() || pending || task.waiting || task.status in listOf("failed", "cancelled")) {
                    val kind = if (pending) "dependency" else toolActivityKind(task.activityName, task.activityInput)
                    Row(Modifier.fillMaxWidth().background(Color(0xFFF7F7F5), RoundedCornerShape(7.dp))
                        .border(.5.dp, Color(0xFFE4E4E1), RoundedCornerShape(7.dp)).padding(horizontal = 7.dp, vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                        Icon(when (kind) { "command" -> Icons.Outlined.Terminal; "read" -> Icons.Outlined.Description
                            "edit", "write" -> Icons.Outlined.Code; "dependency" -> Icons.Outlined.AccountTree
                            "web" -> Icons.Outlined.Language; "mcp" -> Icons.Outlined.Extension; else -> Icons.Outlined.Code }, null,
                            Modifier.size(15.dp), tint = TeamText)
                        Text(if (pending || task.waiting || task.status in listOf("failed", "cancelled")) teamTaskWaiting(task, tasks) else teamActivityText(task),
                            fontSize = 12.sp, lineHeight = 17.sp, color = TeamText, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        if (task.sessionId.isNotEmpty()) Icon(Icons.Outlined.ChevronRight, null, Modifier.size(16.dp), tint = TeamText)
                    }
                }
            }
            if (retry != null && task.status in listOf("failed", "cancelled") && task.dependencies.all { dependency -> tasks.any { it.id == dependency && it.completed } }) {
                TextButton(onClick = { retry(task) }, modifier = Modifier.align(Alignment.End).testTag("retry-task:${task.id}")) {
                    Icon(Icons.Outlined.Refresh, null, Modifier.size(16.dp), tint = TeamText)
                    Spacer(Modifier.width(5.dp)); Text("重试此任务", color = TeamText, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                }
            }
            if (task.fileCount > 0 || task.additions != null || task.deletions != null) Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                if (task.fileCount > 0) TaskMetric("${task.fileCount} 个文件", Color(0xFFEEEEEB), TeamText, true)
                task.additions?.let { TaskMetric("+$it", Color(0xFFE3F0DE), Color(0xFF247128)) }
                task.deletions?.let { TaskMetric("−$it", Color(0xFFF9EED6), Color(0xFF956714)) }
            }
        }
    }
}

@Composable private fun TaskMetric(text: String, background: Color, foreground: Color, file: Boolean = false) {
    Row(Modifier.background(background, RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 1.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (file) Icon(Icons.Outlined.InsertDriveFile, null, Modifier.size(12.dp), tint = foreground)
        Text(text, fontSize = 11.sp, lineHeight = 15.sp, fontWeight = FontWeight.Medium, color = foreground)
    }
}

internal fun teamActivityText(task: TeamTask): String {
    val args = runCatching { JSONObject(task.activityInput) }.getOrNull()
    val description = args?.text("description").orEmpty()
    val path = listOf("file_path", "filePath", "path").firstNotNullOfOrNull { args?.text(it)?.takeIf(String::isNotBlank) }
        ?.replace('\\', '/')?.substringAfterLast('/')
    val kind = toolActivityKind(task.activityName, task.activityInput)
    val action = when (kind) { "command" -> "运行命令"; "edit" -> "编辑"; "write" -> "写入"; "read" -> "读取"
        "search" -> "搜索"; "mcp" -> "使用 MCP"; "web" -> "浏览器"; "skill" -> "读取技能"; else -> "执行代码" }
    val detail = description.ifBlank { path ?: args?.text("command")?.takeIf(String::isNotBlank)
        ?: task.activityInput.takeIf { args == null && it.isNotBlank() && !it.trimStart().startsWith("{") }
        ?: task.activityName.substringAfterLast('/') }
    return "$action · $detail"
}
