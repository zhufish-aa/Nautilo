package app.nautilo.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.data.*
import org.json.JSONObject

internal fun usesEventCard(item: ActivityItem): Boolean = item.kind in setOf("provider_ui", "plan", "recovery", "task", "handoff", "file", "artifact", "verification", "git", "checkpoint", "error", "approval") ||
    item.eventType in setOf("interaction.resolved", "approval.resolved")

@Composable internal fun EventNotice(item: ActivityItem) {
    if (item.kind == "approval") {
        val approved = item.payload.text("decision") == "approved"
        val scope = when(item.payload.text("scope")) { "run" -> "此会话"; "task" -> "此任务"; "project" -> "此项目"; "global" -> "始终允许"; else -> "仅本次" }
        NPanel(modifier = Modifier.fillMaxWidth().padding(vertical = 7.dp), shape = RoundedCornerShape(18.dp), border = BorderStroke(.5.dp, Line)) {
            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(if (approved) Icons.Outlined.VerifiedUser else Icons.Outlined.GppBad, null, Modifier.size(18.dp), tint = Secondary)
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(item.detail.ifBlank { "运行审批" }, fontSize = 14.sp, lineHeight = 23.sp)
                    Text(if (approved) "已批准 · $scope" else "已拒绝", fontSize = 12.sp, color = Secondary)
                }
            }
        }
        return
    }
    if (item.kind == "provider_ui") {
        val uri = LocalUriHandler.current
        val raw = item.payload.optJSONObject("raw")
        val text = item.payload.text("text").ifBlank { raw?.text("instructions").orEmpty() }
        when {
            item.payload.text("method") == "open_url" -> NTextButton({ raw?.text("url")?.let(uri::openUri) }) {
                Text(text.ifBlank { "打开授权链接" }, fontSize = 13.sp)
                Icon(Icons.Outlined.OpenInNew, null, Modifier.padding(start = 5.dp).size(14.dp))
            }
            text.startsWith("[billion-context-pi] Unsupported host:") ->
                ProcessDisclosure(item.id, "扩展兼容性提示 · billion-context-pi", "", Icons.Outlined.Info) {
                    SelectionContainer {
                        Text(text, Modifier.fillMaxWidth().heightIn(max = 200.dp).verticalScroll(rememberScrollState()),
                            fontSize = 13.sp, lineHeight = 20.sp, color = Secondary)
                    }
                }
            text.isNotBlank() -> Text(text, Modifier.padding(vertical = 5.dp), fontSize = 13.sp, lineHeight = 21.sp, color = Secondary)
        }
        return
    }
    var expanded by rememberSaveable(item.id) { mutableStateOf(item.kind in setOf("plan", "recovery", "provider_ui", "error", "handoff")) }
    val failure = item.kind == "error" || item.payload.opt("success") == false || item.payload.opt("passed") == false || item.eventType == "git.conflict"
    NPanel(modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp), shape = RoundedCornerShape(13.dp), border = BorderStroke(.5.dp, Line)) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 6.dp)) {
            NPanel({ expanded = !expanded }, color = Color.Transparent) {
                Row(Modifier.fillMaxWidth().heightIn(min = 36.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                    Icon(when(item.kind) {
                        "file", "git" -> Icons.Outlined.Difference; "plan", "task" -> Icons.Outlined.Checklist
                        "handoff" -> Icons.Outlined.Workspaces; "approval" -> Icons.Outlined.Shield
                        "artifact" -> Icons.Outlined.InsertDriveFile
                        "checkpoint" -> Icons.Outlined.Restore; "followup" -> Icons.Outlined.Schedule
                        "error" -> Icons.Outlined.ErrorOutline; else -> Icons.Outlined.Info
                    }, null, Modifier.size(17.dp), tint = if (failure) Danger else Secondary)
                    Text(item.title, Modifier.weight(1f), fontSize = 14.sp, lineHeight = 22.sp, color = if (failure) Danger else Ink)
                    if (item.running) NSpinner(Modifier.size(13.dp))
                    Icon(if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null, Modifier.size(16.dp), tint = Secondary)
                }
            }
            if (expanded) Box(Modifier.padding(top = 7.dp, bottom = 10.dp)) { EventDetails(item) }
        }
    }
}

@Composable internal fun CollapsedEventText(label: String, detail: String) {
    var expanded by rememberSaveable(detail) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        NTextButton({ expanded = !expanded }, contentPadding = PaddingValues(horizontal = 8.dp)) {
            Icon(if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null, Modifier.size(15.dp), tint = Secondary)
            Text(label, Modifier.padding(start = 5.dp), fontSize = 13.sp, color = Secondary)
        }
        if (expanded) SelectionContainer {
            Text(detail, Modifier.fillMaxWidth().heightIn(max = 200.dp).verticalScroll(rememberScrollState()).padding(horizontal = 8.dp),
                fontSize = 13.sp, lineHeight = 20.sp, color = Secondary)
        }
    }
}

@Composable internal fun EventDetails(item: ActivityItem) {
    val p = item.payload
    val openFile = LocalFileOpener.current
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        if (item.detail.isNotBlank()) {
            if (item.kind in setOf("terminal", "tool")) EventCode(item.detail) else Markdown(item.detail)
        }
        p.optJSONObject("subagent")?.let { sub ->
            Text(listOf(sub.text("agentType", "子 Agent"), sub.text("model"), sub.text("status"), if (sub.optBoolean("background")) "后台运行" else "").filter(String::isNotBlank).joinToString(" · "), fontSize = 13.sp, color = Secondary)
            if (sub.text("task").isNotBlank()) Markdown(sub.text("task"))
        }
        p.optJSONObject("codeExecution")?.let { code ->
            if (code.text("description").isNotBlank()) Text(code.text("description"), fontSize = 14.sp)
            code.objects("calls").forEach { call ->
                Text("${call.text("name")} · ${call.text("status")}", fontSize = 13.sp, color = Secondary)
                call.opt("input")?.takeIf { it != JSONObject.NULL }?.let { EventCode(if (it is JSONObject) it.toString(2) else it.toString(), "javascript") }
                call.text("output").takeIf(String::isNotBlank)?.let { EventCode(it) }
            }
        }
        p.optJSONObject("fileDiff")?.let { diff ->
            Text(diff.text("path", "文件变更"), fontSize = 13.sp, color = Secondary)
            if (diff.text("before").isNotEmpty()) { Text("修改前", fontSize = 12.sp, color = Secondary); EventCode(diff.text("before")) }
            Text("修改后", fontSize = 12.sp, color = Secondary); EventCode(diff.text("after"))
            if (diff.optBoolean("truncated")) Text("Harness 返回的文件内容已截断。", fontSize = 12.sp, color = Secondary)
        }
        if (p.text("diff").isNotBlank()) EventCode(p.text("diff"), "diff")
        when (item.kind) {
            "plan" -> Text("${p.text("mode")} ${p.strings("taskIds").joinToString("、")}".trim(), fontSize = 13.sp, color = Secondary)
            "recovery" -> Text(listOf(p.text("action"), p.text("taskId"), p.text("assignedMemberId")).filter(String::isNotBlank).joinToString(" · "), fontSize = 13.sp, color = Secondary)
            "handoff" -> Text("${p.text("fromMemberId")} → ${p.text("toMemberId")}", fontSize = 13.sp, color = Secondary)
            "file" -> if (p.has("additions") || p.has("deletions")) Text("+${p.optInt("additions")}  −${p.optInt("deletions")}", fontSize = 13.sp, color = Secondary)
            "interaction" -> p.optJSONObject("interaction")?.let { request ->
                request.optJSONObject("plan")?.text("content")?.let { Markdown(it) }
                request.objects("questions").forEach { q ->
                    Text(q.text("question"), fontSize = 14.sp)
                    val values = request.optJSONObject("response")?.strings(q.text("id")).orEmpty()
                    val answers = request.optJSONObject("response")?.optJSONObject("answers")?.strings(q.text("id")).orEmpty().ifEmpty { values }
                    Text(if (q.optBoolean("isSecret") && answers.isNotEmpty()) "••••••" else answers.joinToString("、").ifEmpty { if (request.text("status") == "cancelled") "已跳过" else "已回应" }, fontSize = 14.sp, color = Secondary)
                }
            }
            "checkpoint" -> { listOf("restored" to "已恢复", "removed" to "已移除", "skipped" to "已跳过").forEach { (key, label) -> if (p.strings(key).isNotEmpty()) Text("$label：${p.strings(key).joinToString("、")}", fontSize = 13.sp, lineHeight = 22.sp) } }
            "git" -> Text(listOf(p.text("sourceBranch"), p.text("targetBranch"), p.text("commit"), p.strings("paths").joinToString("\n")).filter(String::isNotBlank).joinToString(" → "), fontSize = 13.sp, lineHeight = 22.sp)
            "approval" -> Text(if (p.text("decision") == "approved") "已批准 · ${p.text("scope")}" else "已拒绝", fontSize = 14.sp, color = Secondary)
            "task" -> Text("${p.text("taskId")} · ${p.text("status")}", fontSize = 13.sp, color = Secondary)
            "verification" -> Text(listOf(p.text("commandTemplateId"), if (p.has("exitCode")) "退出码 ${p.optInt("exitCode")}" else "", if (p.has("durationMs")) "${p.optLong("durationMs")} ms" else "").filter(String::isNotBlank).joinToString(" · "), fontSize = 13.sp, color = Secondary)
            "artifact" -> {
                val path = p.text("path")
                val reference = app.nautilo.mobile.data.fileReference(path, allowUnknown = true)
                Text(listOf(p.text("kind"), p.text("mimeType")).filter(String::isNotBlank).joinToString(" · "), fontSize = 12.sp, color = Secondary)
                if (path.isNotBlank()) NTextButton({ reference?.let { openFile?.invoke(it) } }, enabled = openFile != null && reference != null) {
                    Icon(Icons.Outlined.InsertDriveFile, null, Modifier.size(17.dp)); Text(path, fontSize = 13.sp)
                }
            }
        }
        if (item.kind == "terminal") Text(listOf(p.text("cwd"), if (p.has("exitCode")) "退出码 ${p.optInt("exitCode")}" else "", if (p.has("durationMs")) "${p.optLong("durationMs")} ms" else "").filter(String::isNotBlank).joinToString(" · "), fontSize = 12.sp, color = Secondary)
    }
}

@Composable internal fun EventCode(text: String, language: String = "text") {
    // Use a fence longer than any fence in tool output so no content becomes markup.
    val longest = Regex("`+").findAll(text).maxOfOrNull { it.value.length } ?: 0
    val fence = "`".repeat(maxOf(3, longest + 1))
    Markdown("$fence$language\n$text\n$fence")
}
