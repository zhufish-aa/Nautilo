package app.nautilo.mobile.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.data.*
import org.json.JSONObject

@Composable internal fun AssistantTurn(entry: ConversationItem.Turn, content: @Composable (MobileTimelineBlock) -> Unit) {
    val status = entry.turn.text("status")
    val completed = status != "running"
    val hasProcess = entry.blocks.isNotEmpty()
    var expanded by rememberSaveable(entry.key, completed) { mutableStateOf(!completed) }
    val duration = if (!entry.turn.isNull("durationMs")) durationLabel(entry.turn.optLong("durationMs") / 1000) else ""
    val label = when (status) {
        "completed" -> "已完成"
        "cancelled" -> "已停止"
        "failed" -> "未完成"
        else -> "执行中"
    }
    Column(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
        val toggle = if (hasProcess) Modifier.clickable { expanded = !expanded } else Modifier
        Row(Modifier.fillMaxWidth().then(toggle).heightIn(min = 32.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (!completed) NSpinner(Modifier.size(10.dp), strokeWidth = 1.2.dp, color = Accent)
            Text(if (duration.isEmpty()) label else "$label，用时 $duration", fontSize = 14.sp, color = Secondary)
            if (hasProcess) Icon(Icons.Outlined.ExpandMore, if (expanded) "收起执行过程" else "展开执行过程",
                Modifier.size(15.dp).rotate(if (expanded) 180f else 0f), tint = Secondary)
        }
        NDivider(thickness = .5.dp, color = Line)
        if (expanded) for (block in entry.blocks) key(block.id) { content(block) }
    }
}

@Composable internal fun TimelineBlockContent(block: MobileTimelineBlock, state: MobileState, model: app.nautilo.mobile.MobileViewModel) {
    val content = block.content
    val payload = content.optJSONObject("payload") ?: JSONObject()
    val result = block.result?.optJSONObject("payload")
    val type = (block.result ?: content).text("type")
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
            ProcessActivity(ActivityItem(block.id, "thought", "思考", content.text("text"), !block.sealed))
        content.has("text") && !content.has("type") -> Markdown(content.text("text"), Modifier.padding(vertical = 7.dp))
        block.kind == "tool_call" || type.startsWith("tool.") || type.startsWith("command.") -> {
            val name = payload.text("toolName", payload.text("command", "工具"))
            val detail = listOf(payload.text("inputSummary"), result?.text("outputSummary") ?: payload.text("outputSummary")).filter(String::isNotEmpty).joinToString("\n")
            ProcessActivity(ActivityItem(block.id, if (type.startsWith("command.")) "terminal" else "tool", name,
                detail, block.status == "running", eventType = type, payload = result ?: payload))
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
