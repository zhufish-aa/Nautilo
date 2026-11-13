package app.nautilo.mobile.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.data.*
import org.json.JSONObject

@Composable internal fun AssistantTurn(turn: ConversationItem.Turn, error: String = "") {
    var expanded by rememberSaveable(turn.id) { mutableStateOf(false) }
    val process = turn.process
    val active = running(turn.run?.status.orEmpty())
    val rotation by animateFloatAsState(if (expanded) 180f else 0f, tween(200), label = "process-chevron")
    Column(Modifier.fillMaxWidth().padding(top = 5.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(9.dp)).clickable(enabled = process.isNotEmpty()) { expanded = !expanded }.heightIn(min = 36.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(25.dp).background(Selection.copy(alpha = .65f), CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.Waves, null, Modifier.size(18.dp), tint = Blue)
            }
            Text("Nautilo", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.width(3.dp))
            turn.run?.let { RunStatusLabel(it) }
            Spacer(Modifier.weight(1f))
            if (process.isNotEmpty()) {
                Text("${process.size} 项过程", fontSize = 11.sp, color = Secondary)
                Icon(Icons.Outlined.ExpandMore, if (expanded) "收起执行过程" else "展开执行过程", Modifier.size(17.dp).rotate(rotation), tint = Secondary)
            }
        }
        AnimatedVisibility(expanded && process.isNotEmpty()) {
            Row(Modifier.fillMaxWidth()) {
                Box(Modifier.width(2.dp).heightIn(min = 24.dp).background(Selection))
                Column(Modifier.weight(1f).padding(start = 9.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    process.forEach { part -> key(part.key) {
                        part.message?.let { Markdown(it.text, Modifier.padding(vertical = 7.dp)) }
                        part.activity?.let { ActivityRow(it) }
                    } }
                }
            }
        }
        if (!expanded && active && process.isNotEmpty()) {
            process.lastOrNull()?.activity?.let { ActivityPreview(it) }
        }
        turn.answer?.let { Markdown(it.text) }
        if (error.isNotBlank()) Surface(color = Color(0xFFFFF5F4), shape = RoundedCornerShape(14.dp)) {
            Row(Modifier.padding(13.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(Icons.Outlined.Info, null, Modifier.size(18.dp), tint = Danger)
                Text(error, color = Danger, fontSize = 13.sp, lineHeight = 21.sp)
            }
        }
    }
}

@Composable private fun RunStatusLabel(run: RunInfo) {
    val active = running(run.status)
    var seconds by remember(run) { mutableLongStateOf(run.elapsedSeconds()) }
    LaunchedEffect(run) { seconds = run.elapsedSeconds(); while (active) { kotlinx.coroutines.delay(1000); seconds = run.elapsedSeconds() } }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (active) CircularProgressIndicator(Modifier.size(10.dp), strokeWidth = 1.2.dp, color = Blue)
        else Icon(if (run.status == "completed") Icons.Outlined.Check else Icons.Outlined.Info, null, Modifier.size(12.dp), tint = if (run.status == "completed") Green else Secondary)
        Text(when (run.status) {
            "completed" -> "已完成"; "cancelled" -> "已停止"; "failed", "crashed", "timed_out" -> "未完成"
            "waiting", "waiting_input", "waiting_approval" -> "等待处理"; "starting", "created" -> "正在启动"
            "cancelling" -> "正在停止"; else -> "执行中"
        } + " · " + durationLabel(seconds), fontSize = 11.sp, color = Secondary, maxLines = 1)
    }
}
private fun durationLabel(seconds: Long) = if (seconds < 60) "$seconds 秒" else "${seconds / 60} 分 ${seconds % 60} 秒"

private fun activityKind(activity: ActivityItem): Pair<androidx.compose.ui.graphics.vector.ImageVector, String> {
    val name = activity.title.lowercase()
    return when {
        activity.kind == "thought" -> Icons.Outlined.Psychology to "思考"
        activity.kind == "terminal" || Regex("pwsh|powershell|bash|shell|exec_command|terminal").containsMatchIn(name) -> Icons.Outlined.Terminal to "运行命令"
        name.contains("browser") -> Icons.Outlined.Language to "浏览器"
        name.contains("skill") -> Icons.Outlined.AutoStories to "读取技能"
        name.contains("read") || name.contains("get_content") -> Icons.Outlined.Description to "读取文件"
        name.contains("write") || name.contains("edit") || name.contains("patch") -> Icons.Outlined.EditNote to "修改文件"
        name.contains("mcp") -> Icons.Outlined.Extension to activity.title.substringAfterLast("__")
        activity.kind == "team" -> Icons.Outlined.Workspaces to "子 Agent"
        else -> Icons.Outlined.Build to activity.title
    }
}
private fun activitySummary(activity: ActivityItem): String {
    val raw = activity.detail
    val input = runCatching { JSONObject(raw.substringBefore("\n")) }.getOrNull()
    return (input?.text("description")?.takeIf { it.isNotBlank() }
        ?: input?.text("command")?.takeIf { it.isNotBlank() }
        ?: input?.text("path")?.takeIf { it.isNotBlank() }
        ?: raw).replace(Regex("[*`#]"), "").replace(Regex("\\s+"), " ").trim()
}
@Composable private fun ActivityPreview(activity: ActivityItem) {
    val (icon, label) = activityKind(activity)
    Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(icon, null, Modifier.size(15.dp), tint = Blue)
        Text(label, fontSize = 12.sp, color = Secondary, maxLines = 1)
        Text(activitySummary(activity), fontSize = 12.sp, color = Secondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
    }
}
@Composable private fun ActivityRow(activity: ActivityItem) {
    var expanded by rememberSaveable(activity.id) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable { expanded = !expanded }.heightIn(min = 36.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { ActivityPreview(activity) }
            Icon(if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ChevronRight, null, Modifier.size(15.dp), tint = Secondary)
        }
        AnimatedVisibility(expanded) {
            if (activity.kind == "thought") Markdown(activity.detail, Modifier.padding(start = 22.dp, bottom = 10.dp))
            else Text(activity.detail, fontSize = 12.sp, lineHeight = 19.sp, fontFamily = CodeFont, color = Ink,
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Color(0xFFF0F5F8)).horizontalScroll(rememberScrollState()).padding(12.dp))
        }
    }
}
