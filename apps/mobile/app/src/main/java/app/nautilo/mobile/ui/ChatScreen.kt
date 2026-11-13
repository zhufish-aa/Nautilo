@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package app.nautilo.mobile.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.MobileViewModel
import app.nautilo.mobile.data.*
import kotlinx.coroutines.launch


@Composable fun ChatScreen(state: MobileState, model: MobileViewModel) {
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val dragged by list.interactionSource.collectIsDraggedAsState()
    var follow by remember(state.session?.id) { mutableStateOf(true) }
    var showModels by remember { mutableStateOf(false) }
    val entries = remember(state.messages, state.activities, state.runs) {
        conversationTimeline(state.messages, state.activities, state.runs)
    }
    val atBottom by remember { derivedStateOf { list.layoutInfo.visibleItemsInfo.lastOrNull()?.index.let { it == null || it >= list.layoutInfo.totalItemsCount - 2 } } }
    LaunchedEffect(dragged) {
        if (dragged) snapshotFlow { atBottom }.collect { follow = it }
        else if (atBottom) follow = true
    }
    LaunchedEffect(entries.lastOrNull()?.key, state.messages.lastOrNull()?.text?.length, state.activities.lastOrNull()?.detail?.length, state.interactions.size, state.approvals.size, state.busy) {
        if (follow && list.layoutInfo.totalItemsCount > 0) list.animateScrollToItem(list.layoutInfo.totalItemsCount - 1)
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        Box(Modifier.weight(1f)) {
            LazyColumn(state = list, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (state.hasOlder) item("older") { Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { TextButton(onClick = model::older) { Text("查看更早的消息", fontSize = 12.sp) } } }
                items(entries, key = { it.key }) { entry ->
                    Box(Modifier.animateItem(fadeInSpec = null, fadeOutSpec = null, placementSpec = spring(stiffness = Spring.StiffnessMedium, dampingRatio = Spring.DampingRatioNoBouncy))) {
                        when (entry) {
                            is ConversationItem.Message -> MessageRow(entry.value, model::retryMessages)
                            is ConversationItem.Turn -> AssistantTurn(entry, if (entry.id == state.runId) state.runError else "")
                        }
                    }
                }
                items(state.interactions.filter { it.text("status") == "pending" }, key = { "question:${it.text("id")}" }) { InteractionCard(it, state.readOnly || !state.connected, model) }
                items(state.approvals.filter { it.text("status") == "pending" }, key = { "approval:${it.text("id")}" }) { approval ->
                    ApprovalCard(approval, state.readOnly || !state.connected, model)
                }
                item("progress") {
                    if (state.busy) Row(Modifier.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 1.7.dp)
                        Text("正在同步会话", fontSize = 13.sp, color = Secondary)
                    }
                    else if (entries.isEmpty()) EmptyView(Icons.Outlined.ChatBubbleOutline, "继续电脑上的工作", "消息和任务会同步到这台手机。")
                }
                item("end") { Spacer(Modifier.height(2.dp)) }
            }
            if (!atBottom) SmallFloatingActionButton(onClick = { follow = true; scope.launch { list.animateScrollToItem((list.layoutInfo.totalItemsCount - 1).coerceAtLeast(0)) } },
                modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp), containerColor = Color.White, contentColor = Ink) { Icon(Icons.Outlined.ArrowDownward, "回到最新消息", Modifier.size(18.dp)) }
        }
        Composer(state, model, { showModels = true; model.loadModels() }) { follow = true }
    }
    if (showModels) SessionConfigurationSheet(state, model) { showModels = false }
}

@Composable private fun MessageRow(message: ChatMessage, retry: () -> Unit) {
    if (message.sender == "user") Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        MessageArrival(message.id, message.delivery != "sent") {
            Surface(shape = RoundedCornerShape(19.dp, 19.dp, 5.dp, 19.dp), color = Selection, modifier = Modifier.widthIn(max = 330.dp)) {
                Text(message.text, Modifier.padding(horizontal = 15.dp, vertical = 12.dp), fontSize = 15.sp, lineHeight = 23.sp)
            }
        }
        Row(Modifier.padding(top = 5.dp, bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(shortTime(message.time), fontSize = 10.sp, color = Secondary)
            when(message.delivery) {
                "sending" -> CircularProgressIndicator(Modifier.size(10.dp), strokeWidth = 1.dp)
                "waiting", "review" -> Text(if (message.delivery == "waiting") "等待连接 · 重试" else "需确认 · 重试", color = Blue, fontSize = 11.sp, modifier = Modifier.clickable(onClick = retry))
                "failed" -> Text("未发送", color = Danger, fontSize = 11.sp)
                else -> {}
            }
        }
    } else Column(Modifier.fillMaxWidth().padding(top = 6.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
        Markdown(message.text)
    }
}

@Composable private fun Composer(state: MobileState, model: MobileViewModel, models: () -> Unit, sending: () -> Unit) {
    val voice = rememberVoiceInput { model.draft((state.draft + " " + it).trim()) }
    var queue by remember { mutableStateOf(false) }
    val active = running(state.runStatus)
    Column(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 12.dp)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 9.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = models, enabled = state.connected && !state.changing, contentPadding = PaddingValues(horizontal = 4.dp, vertical = 6.dp)) {
                Icon(Icons.Outlined.ViewInAr, null, Modifier.size(14.dp), tint = Ink)
                Text("  " + (state.session?.model?.substringAfterLast('/')?.take(29) ?: "模型"), fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, color = Ink, modifier = Modifier.widthIn(max = 180.dp))
                Icon(Icons.Outlined.ExpandMore, null, Modifier.size(13.dp), tint = Secondary)
            }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = models, enabled = state.connected) { Text("推理  " + effortName(state.session?.effort.orEmpty()).ifEmpty { "默认" }, fontSize = 11.sp, color = Ink); Icon(Icons.Outlined.ExpandMore, null, Modifier.size(13.dp), tint = Secondary) }
        }
        if (active) Row(Modifier.padding(start = 10.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            FilterChip(selected = queue, onClick = { queue = !queue }, label = { Text(if (queue) "下一轮发送" else "立即引导", fontSize = 11.sp) }, modifier = Modifier.height(29.dp))
            Spacer(Modifier.weight(1f))
            TextButton(onClick = model::cancelRun, enabled = state.connected && !state.readOnly) { Icon(Icons.Outlined.StopCircle, null, Modifier.size(16.dp)); Text(" 停止", fontSize = 12.sp) }
        }
        Surface(shape = RoundedCornerShape(29.dp), color = Color.White, shadowElevation = 1.dp, tonalElevation = 0.dp, border = androidx.compose.foundation.BorderStroke(1.dp, Line.copy(alpha = .8f))) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                BasicTextField(value = state.draft, onValueChange = model::draft, modifier = Modifier.weight(1f).heightIn(min = 40.dp, max = 140.dp).padding(vertical = 6.dp), maxLines = 5,
                    textStyle = TextStyle(color = Ink, fontSize = 15.sp, lineHeight = 23.sp), cursorBrush = SolidColor(Blue), enabled = !state.readOnly,
                    decorationBox = { field -> Box(contentAlignment = Alignment.CenterStart) { if (state.draft.isEmpty()) Text(if (state.readOnly) "此设备仅有查看权限" else "向 Nautilo 发送消息", fontSize = 15.sp, lineHeight = 23.sp, color = Secondary); field() } })
                ActionIcon(Icons.Outlined.MicNone, "语音输入", !state.readOnly, voice)
                SendAction(state.draft.isNotBlank() && !state.readOnly) { sending(); model.send(if (active) if (queue) "queue" else "steer" else null) }
            }
        }
    }
}
