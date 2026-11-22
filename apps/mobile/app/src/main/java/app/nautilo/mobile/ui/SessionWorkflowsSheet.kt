package app.nautilo.mobile.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileViewModel
import app.nautilo.mobile.data.objects
import app.nautilo.mobile.data.text
import kotlinx.coroutines.CancellationException
import org.json.JSONObject

@Composable internal fun SessionWorkflowsSheet(sessionId: String, model: MobileViewModel, close: () -> Unit) {
    var runId by remember { mutableStateOf<String?>(null) }
    var data by remember { mutableStateOf<JSONObject?>(null) }
    var error by remember { mutableStateOf("") }
    var refresh by remember { mutableIntStateOf(0) }
    LaunchedEffect(sessionId, runId, refresh) {
        data = null
        error = ""
        try {
            data = model.workflowDetails(sessionId, runId)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            error = failure.message ?: "加载工作流失败"
        }
    }
    NSheet(onDismissRequest = close) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(data?.text("name")?.ifBlank { null } ?: "工作流执行",
                    style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                NTextButton(onClick = { refresh++ }) { Text("刷新") }
                NTextButton(onClick = { if (runId == null) close() else runId = null }) {
                    Text(if (runId == null) "完成" else "返回")
                }
            }
            val snapshot = data
            when {
                error.isNotEmpty() -> Text(error, color = Danger, modifier = Modifier.padding(vertical = 12.dp))
                snapshot == null -> NSpinner(Modifier.padding(12.dp).size(18.dp))
                else -> {
                    if (runId != null) Text(workflowStatus(snapshot.text("status")), color = Secondary, fontSize = 13.sp)
                    val items = snapshot.objects(if (runId == null) "items" else "instances")
                    if (items.isEmpty()) Text("暂无执行记录", color = Secondary, modifier = Modifier.padding(vertical = 12.dp))
                    LazyColumn(Modifier.fillMaxWidth().heightIn(max = 420.dp), contentPadding = PaddingValues(vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        items(items, key = { it.text("id") }) { item ->
                            val open = if (runId == null) ({ runId = item.text("id") }) else null
                            NPanel(onClick = open, modifier = Modifier.fillMaxWidth()) {
                                Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                                    Text(item.text("name").ifBlank { "工作流" }, Modifier.weight(1f), fontSize = 14.sp)
                                    Text(workflowStatus(item.text("status")), color = Secondary, fontSize = 12.sp)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun workflowStatus(value: String) = when (value) {
    "running", "verifying", "starting" -> "运行中"
    "completed" -> "已完成"
    "finalizing" -> "收尾中"
    "needs_decision", "waiting_approval" -> "待处理"
    "waiting_retry" -> "待重试"
    "ready", "waiting_join", "waiting_submission" -> "等待中"
    "failed" -> "失败"
    "cancelled" -> "已停止"
    "paused" -> "已暂停"
    else -> value
}
