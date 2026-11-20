@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package app.nautilo.mobile.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
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
    val list = rememberSaveable(state.host?.id, state.session?.id, saver = LazyListState.Saver) { LazyListState() }
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val dragged by list.interactionSource.collectIsDraggedAsState()
    var follow by rememberSaveable(state.host?.id, state.session?.id) { mutableStateOf(true) }
    var showModels by remember { mutableStateOf(false) }
    var showModes by remember { mutableStateOf(false) }
    val entries = remember(state.messages, state.activities, state.runs, state.interactions) {
        conversationTimeline(state.messages, state.activities, state.runs, state.interactions)
    }
    val atBottom by remember { derivedStateOf { list.layoutInfo.visibleItemsInfo.lastOrNull()?.index.let { it == null || it >= list.layoutInfo.totalItemsCount - 2 } } }
    LaunchedEffect(dragged) {
        if (dragged) snapshotFlow { atBottom }.collect { follow = it }
        else if (atBottom) follow = true
    }
    LaunchedEffect(entries.lastOrNull()?.key, state.messages.lastOrNull()?.text?.length, state.activities.lastOrNull()?.detail?.length, state.interactions.size, state.approvals.size, state.busy) {
        // One layout-frame pin, not a new smooth-scroll animation for every token.
        // Explicit "back to latest" below still animates; dragging always wins.
        withFrameNanos { }
        if (follow && !dragged && list.layoutInfo.totalItemsCount > 0) list.scrollToItem(list.layoutInfo.totalItemsCount - 1)
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        Box(Modifier.weight(1f)) {
            LazyColumn(state = list, modifier = Modifier.fillMaxSize().pointerInput(Unit) { awaitEachGesture { awaitFirstDown(requireUnconsumed = false); focus.clearFocus(); keyboard?.hide() } }, contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (state.hasOlder) item("older") { Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { NTextButton(onClick = model::older) { Text("查看更早的消息", fontSize = 12.sp) } } }
                items(entries, key = { it.key }) { entry ->
                    Box(Modifier.animateItem(fadeInSpec = null, fadeOutSpec = null, placementSpec = spring(stiffness = Spring.StiffnessMedium, dampingRatio = Spring.DampingRatioNoBouncy))) {
                        when (entry) {
                            is ConversationItem.Message -> MessageRow(entry.value, state.session?.id.orEmpty(), model::retryMessages)
                            is ConversationItem.Turn -> AssistantTurn(entry) { request ->
                                InteractionCard(request, state.readOnly || !state.connected, model)
                            }
                        }
                    }
                }
                items(state.approvals.filter { it.text("status") == "pending" }, key = { "approval:${it.text("id")}" }) { approval ->
                    ApprovalCard(approval, state.readOnly || !state.connected, model, scopeSelection = "approval.scopes" in state.capabilities)
                }
                item("progress") {
                    if (state.busy) Row(Modifier.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        NSpinner(Modifier.size(16.dp), strokeWidth = 1.7.dp)
                        Text("正在同步会话", fontSize = 13.sp, color = Secondary)
                    }
                    else if (entries.isEmpty() && state.interactions.isEmpty() && state.approvals.isEmpty()) EmptyView(Icons.Outlined.ChatBubbleOutline, "继续电脑上的工作", "消息和任务会同步到这台手机。")
                }
                item("end") { Spacer(Modifier.height(2.dp)) }
            }
            if (!atBottom) NFloatingActionButton(onClick = { follow = true; scope.launch { list.animateScrollToItem((list.layoutInfo.totalItemsCount - 1).coerceAtLeast(0)) } },
                modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp), containerColor = Color.White, contentColor = Ink) { Icon(Icons.Outlined.ArrowDownward, "回到最新消息", Modifier.size(18.dp)) }
        }
        Composer(state, model, { showModels = true }, { showModes = true }) { follow = true }
    }
    if (showModels) SessionConfigurationSheet(state, model) { showModels = false }
    if (showModes) state.session?.let { session ->
        LaunchedEffect(session.agentId, session.projectId) { model.clearError(); model.loadModes(session.agentId, session.projectId) }
        ModeConfigurationSheet(state.modes, state.modesLoading, session.permissionMode, session.agentMode,
            session.modeLocked || state.messages.any { it.sender == "user" }, state.changing, state.error,
            refresh = { model.loadModes(session.agentId, session.projectId, true) }, close = { showModes = false }) { permission, mode ->
            model.configureModes(permission, mode) { showModes = false }
        }
    }
}

@Composable internal fun MessageRow(message: ChatMessage, sessionId: String = "", retry: () -> Unit) {
    if (message.sender == "user") Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        MessageArrival(message.id, message.delivery != "sent") {
            NPanel(shape = RoundedCornerShape(22.dp), color = Color(0xFFF0F0F0), modifier = Modifier.widthIn(max = 330.dp)) {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    message.attachments.forEach { attachment ->
                        if (attachment.isImage) AttachmentImage(attachment, sessionId)
                        else Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Icon(Icons.Outlined.InsertDriveFile, null, Modifier.size(16.dp), tint = ComposerSecondary)
                            Text(attachment.name, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    if (message.attachments.isEmpty()) message.attachmentNames.forEach { name -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(Icons.Outlined.InsertDriveFile, null, Modifier.size(16.dp), tint = ComposerSecondary)
                        Text(name, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    } }
                    if (message.text.isNotBlank() && !(message.attachments.isNotEmpty() && message.text == "请查看附件。")) Text(message.text, fontSize = 17.sp, lineHeight = 27.sp)
                }
            }
        }
        if (message.delivery != "sent") Row(Modifier.padding(top = 7.dp, bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            when(message.delivery) {
                "sending" -> NSpinner(Modifier.size(10.dp), strokeWidth = 1.dp)
                "waiting", "review" -> Text(if (message.delivery == "waiting") "等待连接 · 重试" else "需确认 · 重试", color = Secondary, fontSize = 13.sp, modifier = Modifier.clickable(onClick = retry))
                "failed" -> Text("未发送", color = Danger, fontSize = 13.sp)
                else -> {}
            }
        }
    } else Column(Modifier.fillMaxWidth().padding(top = 6.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
        Markdown(message.text)
    }
}

@Composable private fun Composer(state: MobileState, model: MobileViewModel, models: () -> Unit, modes: () -> Unit, sending: () -> Unit) {
    val voice = rememberVoiceInput { model.draft((state.draft + " " + it).trim()) }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { model.addAttachments(it) }
    var queue by remember { mutableStateOf(false) }
    val active = running(state.runStatus)
    Column {
        if (active && state.draftAttachments.isNotEmpty()) Text("当前轮结束后可发送附件", Modifier.padding(start = 24.dp, top = 6.dp), fontSize = 12.sp, color = ComposerSecondary)
        ChatComposer(text = state.draft, onText = model::draft, placeholder = if (state.readOnly) "此设备仅有查看权限" else "发送消息",
            enabled = !state.readOnly, canSend = (state.draft.isNotBlank() || state.draftAttachments.isNotEmpty()) && !state.readOnly && !(active && state.draftAttachments.isNotEmpty()),
            attachments = state.draftAttachments, attachmentBusy = state.attachmentLoading, attachEnabled = !state.readOnly && !active,
            onAttach = { files.launch(arrayOf("*/*")) }, onRemoveAttachment = { model.removeAttachment(it) }, onVoice = voice,
            onSend = { sending(); model.send(if (active) if (queue) "queue" else "steer" else null) },
            configurationEnabled = state.connected && !state.changing, onConfiguration = models,
            onModes = if ("session.modes" in state.capabilities) modes else null,
            onStop = if (active && state.connected && !state.readOnly) model::cancelRun else null,
            focusedContent = { if (active) Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp).padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                NChip(selected = queue, onClick = { queue = !queue }, label = { Text(if (queue) "下一轮发送" else "立即引导", fontSize = 12.sp) }, colors = FilterChipDefaults.filterChipColors(selectedContainerColor = Color(0xFFF0F0F0), selectedLabelColor = Ink))
                Spacer(Modifier.weight(1f))
                NTextButton(onClick = model::cancelRun, enabled = state.connected && !state.readOnly) { Text("停止生成", fontSize = 12.sp, color = Ink) }
            } })
    }
}
