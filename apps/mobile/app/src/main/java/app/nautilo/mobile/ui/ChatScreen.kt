@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package app.nautilo.mobile.ui

import androidx.compose.animation.AnimatedVisibility
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
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
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
    var choices by rememberSaveable(state.host?.id, state.session?.id) { mutableStateOf(hashMapOf<String, Boolean>()) }
    var showModels by remember { mutableStateOf(false) }
    var showModes by remember { mutableStateOf(false) }
    val entries = remember(state.timeline) { state.timeline?.let(::conversationTimeline).orEmpty() }
    val previousTimeline = remember(state.host?.id, state.session?.id) { arrayOfNulls<MobileTimeline>(1) }
    val reveal = remember(state.timeline) {
        val previous = previousTimeline[0]
        val current = state.timeline
        if (previous != null && current != null && current.revision > previous.revision) {
            val tail = previous.blocks.lastOrNull()?.seq ?: 0L
            current.blocks.takeLastWhile { it.seq > tail }.filter { !it.sealed }.map { it.id }.toMutableSet()
        } else mutableSetOf()
    }
    SideEffect { previousTimeline[0] = state.timeline }
    val activeTurn = state.timeline?.turns?.values?.lastOrNull { it.text("status") == "running" }
    val runId = activeTurn?.text("runId") ?: state.runId
    val live = activeTurn != null || running(state.runStatus) && state.timeline?.turns?.get(runId) == null
    val latest = remember(state.timeline, runId) {
        state.timeline?.blocks?.lastOrNull { it.runId == runId && it.kind in setOf("tool_call", "thinking", "assistant_text", "assistant_note", "approval", "interaction") }
    }
    val startedAt = state.runs.firstOrNull { it.id == runId }?.startedAt.orEmpty()
    val threshold = with(LocalDensity.current) { 48.dp.roundToPx() }
    val atBottom by remember(list, threshold) { derivedStateOf {
        val layout = list.layoutInfo
        val tail = layout.visibleItemsInfo.lastOrNull()
        !list.canScrollForward || tail != null && tail.index == layout.totalItemsCount - 1 &&
            tail.offset + tail.size + layout.afterContentPadding - layout.viewportEndOffset <= threshold
    } }
    val readScroll = remember(list, threshold) {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (source == NestedScrollSource.UserInput && available.y > 0 && list.canScrollBackward) follow = false
                return Offset.Zero
            }

            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                if (source == NestedScrollSource.UserInput && consumed.y < 0 && atBottom) follow = true
                return Offset.Zero
            }
        }
    }
    fun pinAfterLayout() {
        if (follow && !dragged && !list.isScrollInProgress && list.layoutInfo.totalItemsCount > 0) {
            list.requestScrollToItem(list.layoutInfo.totalItemsCount - 1)
        }
    }
    LaunchedEffect(list) {
        snapshotFlow { list.canScrollForward }.collect { canScroll -> if (!canScroll) follow = true }
    }
    LaunchedEffect(entries.lastOrNull()?.key, state.timeline?.revision, state.busy, live) {
        // One layout-frame pin, not a new smooth-scroll animation for every token.
        // Explicit "back to latest" below still animates; dragging always wins.
        withFrameNanos { }
        pinAfterLayout()
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        Box(Modifier.weight(1f)) {
            LazyColumn(state = list, modifier = Modifier.fillMaxSize().testTag("chat-timeline").nestedScroll(readScroll)
                .pointerInput(Unit) { awaitEachGesture { awaitFirstDown(requireUnconsumed = false); focus.clearFocus(); keyboard?.hide() } },
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(entries, key = { it.key }) { entry ->
                    Box(Modifier.testTag("timeline:" + entry.key).onSizeChanged { pinAfterLayout() }) {
                        when (entry) {
                            is ConversationItem.Block -> {
                                TimelineBlockContent(entry.block, state, model, reveal = entry.block.id in reveal)
                                SideEffect { reveal.remove(entry.block.id) }
                            }
                            is ConversationItem.Process -> {
                                val running = entry.turn.text("status") == "running"
                                val open = running || choices[entry.turn.text("runId")] == true
                                AssistantTurn(entry, open, running && entry === entries.lastOrNull(), choices,
                                    { id, value -> choices = HashMap(choices).apply { put(id, value) } }) { block ->
                                    TimelineBlockContent(block, state, model, inProcess = true, reveal = block.id in reveal)
                                    SideEffect { reveal.remove(block.id) }
                                }
                            }
                            is ConversationItem.Summary -> {
                                val id = entry.turn.text("runId")
                                TurnSummary(entry, choices[id] == true) {
                                    choices = HashMap(choices).apply { put(id, choices[id] != true) }
                                }
                            }
                        }
                    }
                }
                item("progress") {
                    TurnFrontier(live, runId, startedAt, latest)
                    if (!live && (state.busy || state.timeline == null)) Row(Modifier.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        NSpinner(Modifier.size(16.dp), strokeWidth = 1.7.dp)
                        Text("正在同步会话", fontSize = 13.sp, color = Secondary)
                    }
                    else if (!live && entries.isEmpty()) EmptyView(Icons.Outlined.ChatBubbleOutline, "继续电脑上的工作", "消息和任务会同步到这台手机。")
                }
                item("end") { Spacer(Modifier.height(2.dp)) }
            }
            if (!follow && list.canScrollForward) NFloatingActionButton(onClick = { follow = true; scope.launch { list.animateScrollToItem((list.layoutInfo.totalItemsCount - 1).coerceAtLeast(0)) } },
                modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp), containerColor = MobilePalette.floating, contentColor = Ink) { Icon(Icons.Outlined.ArrowDownward, "回到最新消息", Modifier.size(18.dp)) }
        }
        Composer(state, model, { showModels = true }, { showModes = true }) { follow = true }
    }
    if (showModels) SessionConfigurationSheet(state, model) { showModels = false }
    if (showModes) state.session?.let { session ->
        LaunchedEffect(session.agentId, session.projectId) { model.clearError(); model.loadModes(session.agentId, session.projectId) }
        ModeConfigurationSheet(state.modes, state.modesLoading, session.permissionMode, session.agentMode,
            session.modeLocked || state.timeline?.blocks.orEmpty().any { it.content.text("sender") == "user" }, state.changing, state.error,
            refresh = { model.loadModes(session.agentId, session.projectId, true) }, close = { showModes = false }) { permission, mode ->
            model.configureModes(permission, mode) { showModes = false }
        }
    }
}

@Composable internal fun MessageRow(message: ChatMessage, sessionId: String = "", retry: () -> Unit) {
    if (message.sender == "user") Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        MessageArrival(message.id, message.delivery != "sent") {
            NPanel(shape = RoundedCornerShape(22.dp), color = Selection, modifier = Modifier.widthIn(max = 330.dp)) {
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
                    if (message.text.isNotBlank() && !(message.attachments.isNotEmpty() && message.text == "请查看附件。")) {
                        SelectionContainer { Text(message.text, color = Ink, fontSize = 17.sp, lineHeight = 27.sp) }
                    }
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
                NChip(selected = queue, onClick = { queue = !queue }, label = { Text(if (queue) "下一轮发送" else "立即引导", fontSize = 12.sp) })
                Spacer(Modifier.weight(1f))
                NTextButton(onClick = model::cancelRun, enabled = state.connected && !state.readOnly) { Text("停止生成", fontSize = 12.sp, color = Ink) }
            } })
    }
}
