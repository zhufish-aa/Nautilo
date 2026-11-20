package app.nautilo.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** Android presentation of PC ProcessDisclosure/ToolActivityCard/CodeExecutionCard. */
@Composable internal fun ProcessActivity(item: ActivityItem) {
    val p = item.payload
    val input = p.text("inputSummary", if (item.kind == "terminal") p.text("command", item.title) else item.detail.substringBefore('\n'))
    val output = p.text("outputSummary")
    val status = activityStatus(item)
    when {
        item.kind == "thought" -> ProcessDisclosure(item.id, "思考", reasoningPreview(item.detail), Icons.Outlined.Psychology, item.running, followPreviewTail = true) { Markdown(item.detail, fontSize = 14f, lineHeight = 23f, color = Secondary) }
        p.optJSONObject("subagent") != null || item.kind == "team" -> DelegationActivity(item)
        p.optJSONObject("codeExecution") != null || item.title == "run_code" -> CodeExecutionActivity(item, input, output)
        else -> {
            val inferred = remember(item.title, input, p.optJSONObject("fileDiff")?.toString()) { p.optJSONObject("fileDiff") ?: toolInputFileDiff(item.title, input) }
            val label = if (item.kind == "terminal") "运行 ${p.text("command", item.title).replace(Regex("\\s+"), " ")}" else toolActivityLabel(item.title, status, input)
            ProcessDisclosure(item.id, label, "", toolIcon(if (item.kind == "terminal") "command" else toolActivityKind(item.title, input)), item.running, status == "failed",
                enabled = inferred != null || input.isNotBlank() || output.isNotBlank()) {
                NPanel(shape = RoundedCornerShape(12.dp), border = BorderStroke(.5.dp, Line)) {
                    Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        if (inferred != null) ToolDiff(inferred)
                        if (input.isNotBlank()) {
                            if (inferred == null) EventCode(input) else ProcessDisclosure("${item.id}:raw", "原始输入", "", Icons.Outlined.Code) { EventCode(input) }
                        }
                        if (output.isNotBlank()) { if (input.isNotBlank() || inferred != null) NDivider(); ToolOutputView(output, status == "failed") }
                        if (p.has("exitCode")) Text("退出码 ${p.optInt("exitCode")}", color = if (p.optInt("exitCode") == 0) Secondary else Danger, fontSize = 12.sp)
                    }
                }
            }
        }
    }
}

private fun toolIcon(kind: String): ImageVector = when (kind) {
    "command" -> Icons.Outlined.Terminal; "read" -> Icons.Outlined.Description; "write", "edit" -> Icons.Outlined.EditNote
    "skill" -> Icons.Outlined.AutoStories; "search" -> Icons.Outlined.Search; "mcp" -> Icons.Outlined.Extension
    "web" -> Icons.Outlined.Language; "image" -> Icons.Outlined.Image; "code" -> Icons.Outlined.Code
    "question" -> Icons.Outlined.HelpOutline; else -> Icons.Outlined.Build
}

@Composable private fun ProcessDisclosure(id: String, label: String, preview: String, icon: ImageVector,
    running: Boolean = false, failed: Boolean = false, retainPreview: Boolean = false, enabled: Boolean = true, followPreviewTail: Boolean = false,
    content: @Composable () -> Unit) {
    var open by rememberSaveable(id) { mutableStateOf(false) }
    val previewScroll = rememberScrollState()
    LaunchedEffect(preview, previewScroll.maxValue, open) {
        if (followPreviewTail && !open) previewScroll.scrollTo(previewScroll.maxValue)
    }
    val angle by animateFloatAsState(if (open) 90f else 0f,
        tween(if (LocalNautiloMotion.current) 180 else 0, easing = MotionEase), label = "tool-chevron")
    val tone = if (failed) Danger else Secondary
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().clickable(enabled = enabled) { open = !open }.heightIn(min = 36.dp).padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            if (running && !open) NSpinner(Modifier.size(14.dp), color = tone)
            else Icon(if (open) Icons.Outlined.ExpandLess else if (failed) Icons.Outlined.ErrorOutline else icon, null, Modifier.size(15.dp), tint = tone)
            if (preview.isBlank() || open && !retainPreview) Text(label, Modifier.weight(1f), fontSize = 14.sp, lineHeight = 22.sp, color = tone, maxLines = 1, overflow = TextOverflow.Ellipsis)
            else {
                Text(label, fontSize = 14.sp, color = tone, maxLines = 1)
                Text("·", color = tone, fontSize = 14.sp)
                Text(preview, Modifier.weight(1f).then(if (followPreviewTail) Modifier.horizontalScroll(previewScroll, enabled = false).testTag("process-preview:$id") else Modifier),
                    fontSize = 14.sp, color = tone, maxLines = 1, softWrap = false, overflow = if (followPreviewTail) TextOverflow.Clip else TextOverflow.Ellipsis)
            }
            if (enabled) Icon(Icons.Outlined.ChevronRight, null, Modifier.size(13.dp).graphicsLayer { rotationZ = angle }, tint = tone)
        }
        if (open && enabled) MotionArrival(id, animate = true, distance = 3.dp) {
            Box(Modifier.fillMaxWidth().padding(start = 22.dp, top = 5.dp, bottom = 10.dp)) { content() }
        }
    }
}

@Composable private fun CodeExecutionActivity(item: ActivityItem, input: String, output: String) {
    val program = remember(input) { codeExecutionInput(input) }
    val execution = item.payload.optJSONObject("codeExecution")
    val calls = execution?.objects("calls").orEmpty()
    val branches = remember(execution?.toString()) { toolCallTree(calls) }
    val first = calls.find { it.text("status") == "running" } ?: calls.firstOrNull()
    val receipt = remember(output) { toolOutput(output) }
    val preview = listOfNotNull((program.description ?: execution?.text("description"))?.lineSequence()?.firstOrNull()?.takeIf(String::isNotBlank)
        ?: first?.let { codeCallDescription(it).let { description -> description.second.ifBlank { description.first } } }, receipt.status).joinToString(" · ")
    Column {
        ProcessDisclosure(item.id, "执行代码", preview, Icons.Outlined.Code, item.running, activityStatus(item) == "failed", retainPreview = true) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (program.code.isNotBlank()) EventCode(program.code, "javascript")
                if (program.truncated) Text("历史记录仅保存了部分代码", fontSize = 12.sp, color = Secondary)
                ToolOutputView(output, activityStatus(item) == "failed")
            }
        }
        branches.forEach { branch -> key(branch.call.text("callId")) { CodeCallView(branch, item.id, 0) } }
    }
}

@Composable private fun CodeCallView(branch: ToolCallBranch, run: String, depth: Int) {
    val call = branch.call
    val description = remember(call.toString()) { codeCallDescription(call) }
    val raw = call.opt("input")
    val input = remember(raw?.toString()) { if (raw is JSONObject) raw else runCatching { JSONObject(raw?.toString().orEmpty()) }.getOrDefault(JSONObject()) }
    Column(Modifier.fillMaxWidth().padding(start = if (depth < 4) 14.dp else 3.dp)) {
        ProcessDisclosure("$run:${call.text("callId")}", description.first, description.second, toolIcon(toolActivityKind(call.text("name"))), call.text("status") == "running", call.text("status") == "failed", retainPreview = true) {
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                if (input.text("code").isNotBlank()) EventCode(input.text("code"), "javascript")
                if (input.length() == 0 && raw != null && raw != JSONObject.NULL) EventCode(raw.toString())
                input.keys().forEach { field -> if (field !in listOf("description", "code")) KeyValue(field, input.opt(field)?.toString().orEmpty()) }
                ToolOutputView(call.text("output"), call.text("status") == "failed")
            }
        }
        branch.children.forEach { child -> key(child.call.text("callId")) { CodeCallView(child, run, depth + 1) } }
    }
}

@Composable private fun ToolOutputView(output: String, failed: Boolean) {
    if (output.isBlank()) return
    val result = remember(output) { toolOutput(output) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Text("输出", fontSize = 12.sp, color = Secondary)
        result.status?.let { Text(it, fontSize = 14.sp, color = if (failed) Danger else Ink) }
        result.fields.forEach { (label, value) -> KeyValue(label, value) }
        if (result.text.isNotBlank()) EventCode(result.text)
    }
}
@Composable private fun KeyValue(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.widthIn(min = 46.dp, max = 92.dp), fontSize = 12.sp, lineHeight = 21.sp, color = Secondary)
        SelectionContainer(Modifier.weight(1f)) { Text(value, fontSize = 13.sp, lineHeight = 21.sp, color = Ink) }
    }
}

@Composable internal fun ToolDiff(diff: JSONObject) {
    val source = diff.toString()
    val rendered by produceState<Pair<FileChange, List<ColoredDiffLine>>?>(null, source) { value = withContext(Dispatchers.Default) {
        val change = FileChange.decode(diff)
        change to coloredLines(change.lines, change.path)
    } }
    val change = rendered?.first
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(diff.text("path", "文件变更"), Modifier.weight(1f), fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            change?.let { Text("+${it.added}", fontSize = 12.sp, color = Green); Text("−${it.removed}", fontSize = 12.sp, color = Danger) }
        }
        val lines = rendered?.second
        if (lines == null) NSpinner(Modifier.size(16.dp))
        else SelectionContainer {
            Column(Modifier.fillMaxWidth().heightIn(max = 320.dp).verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState())) {
                lines.forEach { colored ->
                    val line = colored.line
                    val background = when (line.kind) { DiffKind.Added -> Color(0xFFEDF6EF); DiffKind.Removed -> Color(0xFFFCEFF0); else -> Color.Transparent }
                    Row(Modifier.fillMaxWidth().background(background).padding(horizontal = 8.dp, vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text((line.newNumber ?: line.oldNumber)?.toString().orEmpty(), Modifier.width(30.dp), fontSize = 11.sp, fontFamily = CodeFont, color = Secondary)
                        Text(when (line.kind) { DiffKind.Added -> "+"; DiffKind.Removed -> "−"; else -> " " }, fontSize = 12.sp, fontFamily = CodeFont, color = if (line.kind == DiffKind.Removed) Danger else Secondary)
                        Text(colored.text, fontSize = 12.sp, lineHeight = 19.sp, fontFamily = CodeFont, color = Ink)
                    }
                }
            }
        }
        if (diff.optBoolean("truncated")) Text("历史记录仅保存了部分文件内容", fontSize = 12.sp, color = Secondary)
    }
}

@Composable private fun DelegationActivity(item: ActivityItem) {
    val sub = item.payload.optJSONObject("subagent") ?: JSONObject()
    var open by rememberSaveable(item.id) { mutableStateOf(false) }
    NPanel(modifier = Modifier.fillMaxWidth().padding(vertical = 7.dp), shape = RoundedCornerShape(14.dp), border = BorderStroke(.5.dp, Line)) {
        Column(Modifier.padding(13.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                Icon(Icons.Outlined.Workspaces, null, Modifier.size(17.dp), tint = Secondary)
                Text(sub.text("agentType", "子 Agent"), Modifier.weight(1f), fontSize = 14.sp, fontWeight = FontWeight.Medium)
                if (item.running) NSpinner(Modifier.size(13.dp))
                Text(when (sub.text("status", activityStatus(item))) { "running" -> if (sub.optBoolean("background")) "后台运行中" else "执行中"; "failed" -> "未完成"; else -> "已完成" }, fontSize = 12.sp, color = Secondary)
            }
            sub.text("task").takeIf(String::isNotBlank)?.let { Text(it, fontSize = 14.sp, lineHeight = 23.sp) }
            sub.text("model").takeIf(String::isNotBlank)?.let { Text(it, fontSize = 12.sp, color = Secondary) }
            if (item.detail.isNotBlank() || sub.objects("activities").isNotEmpty()) {
                NTextButton({ open = !open }) { Text(if (open) "收起活动" else "查看活动", fontSize = 12.sp) }
                if (open) {
                    val activities = sub.objects("activities")
                    if (activities.isEmpty()) EventDetails(item)
                    else activities.forEach { activity -> key(activity.text("id")) {
                        if (activity.text("kind") == "message") Markdown(activity.text("text"), fontSize = 15f, lineHeight = 25f)
                        else ProcessActivity(ActivityItem(activity.text("id"), activity.text("kind"), activity.text("title"), activity.text("detail"), activity.optBoolean("running"), payload = activity.optJSONObject("payload") ?: JSONObject()))
                    } }
                }
            }
        }
    }
}
