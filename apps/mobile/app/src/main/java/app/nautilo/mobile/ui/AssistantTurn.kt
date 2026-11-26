package app.nautilo.mobile.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.data.*
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.time.Instant

@Composable internal fun TurnSummary(entry: ConversationItem.Summary, expanded: Boolean, onToggle: () -> Unit) {
    val status = entry.turn.text("status")
    val duration = if (entry.turn.isNull("durationMs")) "" else durationLabel(entry.turn.optLong("durationMs") / 1000)
    val label = when (status) { "cancelled" -> "已中断"; "failed" -> "执行异常"; else -> "已完成" }
    val icon = when (status) { "cancelled" -> Icons.Outlined.Stop; "failed" -> Icons.Outlined.ErrorOutline; else -> Icons.Outlined.CheckCircleOutline }
    Column(Modifier.fillMaxWidth()) {
        ProcessHeader(entry.key, if (duration.isEmpty()) label else "$label，用时 $duration", "", icon, expanded,
            failed = status == "failed", iconTint = if (status == "completed") Green else null, onToggle = onToggle)
        NDivider(thickness = .5.dp, color = Line)
    }
}

@Composable internal fun AssistantTurn(entry: ConversationItem.Process, expanded: Boolean, liveTail: Boolean,
    choices: Map<String, Boolean>, choose: (String, Boolean) -> Unit, content: @Composable (MobileTimelineBlock) -> Unit) {
    val clusters = remember(entry.blocks) { toolClusters(entry.blocks) }
    ProcessFold(expanded) {
        Column(Modifier.fillMaxWidth()) {
            clusters.forEachIndexed { index, blocks -> key(blocks.first().id) {
                val first = blocks.first()
                val summary = remember(blocks) { if (first.isToolStep) formatToolClusterSummary(blocks) else null }
                if (summary == null || summary.standalone) content(first)
                else {
                    val id = "tools:" + first.id
                    val open = choices[id] ?: (liveTail && index == clusters.lastIndex)
                    ProcessHeader(id, summary.label, "", toolIcon(summary.kind), open, accessory = {
                        if (summary.failed > 0) Text("· ${summary.failed} 项失败", fontSize = 11.sp, color = Danger)
                    }, onToggle = { choose(id, !open) })
                    ProcessFold(open) {
                        val rail = Line
                        Column(Modifier.fillMaxWidth().padding(start = 7.dp).drawBehind {
                            drawLine(rail, Offset(.5.dp.toPx(), 0f), Offset(.5.dp.toPx(), size.height), strokeWidth = 1.dp.toPx())
                        }.padding(start = 9.dp)) {
                            blocks.forEach { block -> key(block.id) { content(block) } }
                        }
                    }
                }
            } }
        }
    }
}

@Composable internal fun TurnFrontier(active: Boolean, runId: String, startedAt: String, latest: MobileTimelineBlock?) {
    ProcessFold(active) {
        val payload = remember(latest) { latest?.toolPayload }
        val tool = payload?.text("toolName").orEmpty()
        val label = when {
            latest?.status == "running" && (latest.type.startsWith("command.") || toolActivityKind(tool, payload?.text("inputSummary").orEmpty()) == "command") -> "正在运行命令"
            latest?.status == "running" && tool.isNotBlank() -> "正在使用 $tool"
            latest?.kind == "approval" && latest.status == "pending" -> "等待审批"
            latest?.kind in setOf("assistant_text", "assistant_note") && latest?.sealed == false -> "正在回复"
            else -> "正在思考"
        }
        val elapsed by produceState(0L, runId, startedAt, active) {
            if (!active) return@produceState
            val started = runCatching { Instant.parse(startedAt).toEpochMilli() }.getOrDefault(System.currentTimeMillis())
            while (true) {
                val millis = (System.currentTimeMillis() - started).coerceAtLeast(0)
                value = millis / 1000
                delay(1000 - millis % 1000)
            }
        }
        Row(Modifier.fillMaxWidth().padding(vertical = 5.dp).testTag("timeline-frontier"),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (active) NSpinner(Modifier.size(13.dp), strokeWidth = 1.3.dp, color = Accent)
            Text(label, fontSize = 13.sp, fontWeight = FontWeight.Normal, color = Secondary)
            Text("· " + if (elapsed == 0L) "0秒" else durationLabel(elapsed), fontSize = 12.sp, color = Secondary,
                style = LocalTextStyle.current.copy(fontFeatureSettings = "tnum"))
        }
    }
}

@Composable internal fun TimelineBlockContent(block: MobileTimelineBlock, state: MobileState, model: app.nautilo.mobile.MobileViewModel,
    inProcess: Boolean = false, reveal: Boolean = false) {
    val content = block.content
    val payload = block.payload
    val result = block.result?.optJSONObject("payload")
    val type = block.type
    val readonly = state.readOnly || !state.connected
    when {
        block.kind == "user_prompt" || block.kind == "user_append" || block.kind == "legacy" -> {
            val attachments = content.objects("attachments").map(ChatAttachment::decode)
            MessageRow(ChatMessage(block.id, content.text("sender"), content.text("text"), content.text("createdAt"),
                viewId = block.id, attachmentNames = attachments.map { it.name }, attachments = attachments),
                state.session?.id.orEmpty(), model::retryMessages)
        }
        block.kind == "interaction" -> (result ?: payload).optJSONObject("interaction")?.let { InteractionCard(it, readonly, model) }
        block.kind == "approval" -> {
            val approvalId = payload.text("approvalId")
            if (block.status == "pending") {
                val approval = state.approvals.find { it.text("id") == approvalId } ?: JSONObject(payload.toString()).apply {
                    put("id", approvalId)
                    for (key in listOf("taskId", "projectId", "projectRunId")) put(key, content.opt(key))
                }
                ApprovalCard(approval, readonly, model, scopeSelection = "approval.scopes" in state.capabilities)
            } else {
                EventNotice(ActivityItem(block.id, "approval", "审批", payload.text("summary"), payload = payload))
            }
        }
        (block.kind == "thinking" || content.text("sourceKind") == "thinking") ->
            ProcessActivity(ActivityItem(block.id, "thought", "思考", content.text("text"), !block.sealed), reveal = reveal)
        content.has("text") && !content.has("type") -> {
            val raw = content.text("text")
            val text = rememberStreamText(raw, !block.sealed, reveal)
            Column(Modifier.fillMaxWidth().padding(vertical = 7.dp)) {
                Markdown(text.value, fontSize = if (inProcess) 13.5f else 17f, lineHeight = if (inProcess) 23f else 28f,
                    color = if (inProcess) Secondary else Ink, streaming = text.live, fade = text.fade)
                val turn = state.timeline?.turns?.get(block.runId)
                if (!inProcess && !text.live && raw.isNotBlank() && turn?.text("finalBlockId") == block.id) {
                    val clipboard = LocalClipboardManager.current
                    NIconButton(onClick = { clipboard.setText(AnnotatedString(raw)) }, modifier = Modifier.align(Alignment.End)) {
                        Icon(Icons.Outlined.ContentCopy, "复制回复", Modifier.size(16.dp), tint = Secondary)
                    }
                }
            }
        }
        type == "file.changed" && block.kind != "late_result" -> {
            val path = payload.text("path")
            val label = when (payload.text("changeType")) { "added" -> "已创建"; "deleted" -> "已删除"; else -> "已编辑" }
            val patch = payload.text("diff")
            ProcessDisclosure(block.id, label, path.fileName(), toolIcon("edit"), path = path, retainPreview = true,
                enabled = patch.isNotBlank(), accessory = {
                    if (payload.has("additions") && payload.has("deletions")) DiffCounts(payload.optInt("additions"), payload.optInt("deletions"))
                }) {
                val diff = remember(payload) { JSONObject(payload.toString()).put("patch", patch) }
                ToolDiff(diff)
            }
        }
        block.kind == "tool_call" || type.startsWith("tool.") || type.startsWith("command.") -> {
            val metadata = remember(block) { block.toolPayload }
            val name = metadata.text("toolName", metadata.text("command", "工具"))
            val item = ActivityItem(block.id, if (type.startsWith("command.")) "terminal" else "tool", name,
                metadata.text("inputSummary"), block.status == "running", eventType = type, payload = metadata)
            ProcessActivity(item, status = block.status.ifBlank { activityStatus(item) })
        }
        else -> {
            val kind = when {
                type == "run.failed" || type == "provider.background_error" -> "error"
                type.startsWith("file.") -> "file"
                type.startsWith("verification.") -> "verification"
                type.startsWith("task.") -> "task"
                type.startsWith("handoff.") -> "handoff"
                type.startsWith("git.") -> "git"
                type.startsWith("artifact.") -> "artifact"
                else -> "status"
            }
            val detail = payload.text("message", payload.text("summary", payload.text("text", payload.text("path"))))
            EventNotice(ActivityItem(block.id, kind, if (block.kind == "late_result") "上一轮结果" else type, detail, eventType = type, payload = payload))
        }
    }
}

private fun durationLabel(seconds: Long): String = when {
    seconds < 1 -> "不到1秒"
    seconds < 60 -> "${seconds}秒"
    seconds < 3600 -> "${seconds / 60}分" + if (seconds % 60 == 0L) "" else "${seconds % 60}秒"
    else -> "${seconds / 3600}小时" + if (seconds % 3600 / 60 == 0L) "" else "${seconds % 3600 / 60}分"
}
