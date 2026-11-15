@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package app.nautilo.mobile.ui

import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.animation.core.*
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.MobileViewModel
import app.nautilo.mobile.Screen
import app.nautilo.mobile.data.*

/** Compose first, configure in context; the first send creates the native desktop session. */
@Composable fun NewConversationScreen(state: MobileState, model: MobileViewModel) {
    var projectId by rememberSaveable(state.newConversationProjectId, state.host?.id) { mutableStateOf(state.newConversationProjectId ?: state.session?.projectId ?: state.projects.firstOrNull()?.id.orEmpty()) }
    var agentId by rememberSaveable { mutableStateOf(state.session?.agentId.orEmpty()) }
    var connectionId by rememberSaveable { mutableStateOf(state.session?.connectionId.orEmpty()) }
    var selectedModel by rememberSaveable { mutableStateOf("") }
    var effort by rememberSaveable { mutableStateOf("") }
    var permissionMode by rememberSaveable { mutableStateOf("") }
    var agentMode by rememberSaveable { mutableStateOf("") }
    var modeSettings by remember { mutableStateOf(false) }
    var picker by remember { mutableStateOf<CreationPicker?>(null) }
    var newProject by remember { mutableStateOf(false) }
    var configuration by remember { mutableStateOf(false) }
    var configurationBefore by remember { mutableStateOf(listOf("", "", "", "", "", "")) }
    var returnToConfiguration by remember { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { model.addAttachments(it, newConversation = true) }
    val agents = state.setup.objects("agents")
    val connections = state.setup.objects("connections")
    val project = state.projects.find { it.id == projectId }
    val agent = agents.find { it.text("id") == agentId }
    val connection = connections.find { it.text("id") == connectionId }
    val chosen = state.newModels.find { it.text("id") == selectedModel }
    val efforts = chosen?.strings("reasoningEfforts").orEmpty()
    val voice = rememberVoiceInput { text -> model.newDraft((state.newDraft + " " + text).trim()) }
    LaunchedEffect(agents.map { it.text("id") }) {
        if (agents.isNotEmpty() && agents.none { it.text("id") == agentId }) agentId = agents.first().text("id")
    }
    LaunchedEffect(agentId, connectionId) {
        if (agentId.isNotEmpty()) model.loadNewModels(agentId, connectionId)
    }
    LaunchedEffect(agentId, projectId) {
        model.loadModes(agentId, projectId)
    }
    LaunchedEffect(state.newModels) {
        val previous = state.session?.takeIf { it.agentId == agentId && it.connectionId == connectionId }
        val choice = state.newModels.find { it.text("id") == selectedModel }
            ?: state.newModels.find { it.text("id") == previous?.model } ?: state.newModels.firstOrNull()
        choice?.let {
            selectedModel = it.text("id")
            effort = effort.takeIf { value -> value in it.strings("reasoningEfforts") }
                ?: previous?.effort?.takeIf { value -> value in it.strings("reasoningEfforts") } ?: it.text("defaultReasoningEffort")
        }
    }
    val canSend = (state.newDraft.isNotBlank() || state.newAttachments.isNotEmpty()) && !state.attachmentLoading && state.connected && !state.changing && !state.setupLoading &&
        !state.catalogLoading && project != null && agent != null
    val send = {
        if (canSend) model.createSession(projectId, agentId, connectionId, selectedModel, effort, firstMessage = state.newDraft, permissionMode = permissionMode, agentMode = agentMode)
        Unit
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            ActionIcon(Icons.Outlined.ArrowBack, "返回项目") { model.navigate(Screen.Projects) }
            NPanel(onClick = { picker = CreationPicker.Project }, color = Color.Transparent, shape = RoundedCornerShape(12.dp), modifier = Modifier.weight(1f)) {
                Row(Modifier.padding(horizontal = 10.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(project?.name ?: "选择项目", fontSize = 18.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, false))
                    Icon(Icons.Outlined.ExpandMore, null, Modifier.padding(start = 6.dp).size(18.dp), tint = Secondary)
                }
            }
            NPanel(onClick = { model.navigate(Screen.Computers) }, color = Color.White, shape = CircleShape, modifier = Modifier.size(40.dp)) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.DesktopWindows, "电脑连接", Modifier.size(19.dp), tint = Ink)
                    Dot(state.connected, Modifier.align(Alignment.BottomEnd).padding(6.dp))
                }
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth().clickable(indication = null, interactionSource = remember { MutableInteractionSource() }) { focus.clearFocus(); keyboard?.hide() }, contentAlignment = Alignment.Center) {
            androidx.compose.animation.AnimatedVisibility(visible = !WindowInsets.isImeVisible, enter = fadeIn(tween(180)) + scaleIn(tween(260, easing = CubicBezierEasing(.23f, 1f, .32f, 1f)), initialScale = .96f),
                exit = fadeOut(tween(120)) + scaleOut(tween(180), targetScale = .96f)) {
            Column(Modifier.offset(y = (-12).dp).padding(horizontal = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(20.dp)) {
                Text("你说，我在听。", fontSize = 26.sp, lineHeight = 38.sp, fontWeight = FontWeight.Medium, color = Ink)
            }
            }
        }
        ChatComposer(text = state.newDraft, onText = model::newDraft, placeholder = "发送消息", enabled = !state.changing,
            canSend = canSend, busy = state.changing, attachments = state.newAttachments, attachmentBusy = state.attachmentLoading,
            onAttach = { files.launch(arrayOf("*/*")) }, onRemoveAttachment = { model.removeAttachment(it, newConversation = true) }, onVoice = voice, onSend = send,
            configurationEnabled = !state.setupLoading && !state.changing, onConfiguration = {
                focus.clearFocus(); keyboard?.hide()
                configurationBefore = listOf(agentId, connectionId, selectedModel, effort, permissionMode, agentMode)
                configuration = true
            },
            onModes = if ("session.modes" in state.capabilities) { { modeSettings = true } } else null)
    }
    val cancelConfiguration = {
        agentId = configurationBefore[0]; connectionId = configurationBefore[1]
        selectedModel = configurationBefore[2]; effort = configurationBefore[3]
        permissionMode = configurationBefore[4]; agentMode = configurationBefore[5]
        configuration = false; returnToConfiguration = false
    }
    val dismissPicker = {
        picker = null
        if (returnToConfiguration) { returnToConfiguration = false; configuration = true }
    }
    // One window owns the whole flow; pickers never replay the sheet entrance
    // or transfer keyboard focus to a second overlapping dialog.
    if (configuration || picker != null) NSheet(onDismissRequest = { if (picker != null) dismissPicker() else cancelConfiguration() }, containerColor = Color.White) {
      MotionPage(picker?.name ?: "settings") {
        val field = picker
        if (field == null) NewConversationSettingsContent(agent?.text("name") ?: "选择 Harness", connection?.text("name") ?: "原生配置",
            if (state.catalogLoading) "正在加载…" else chosen?.text("displayName", selectedModel) ?: "默认模型",
            if (efforts.isEmpty()) null else effortName(effort).ifEmpty { "默认" }, !state.catalogLoading,
            cancel = cancelConfiguration, done = { configuration = false }, choose = { value ->
                returnToConfiguration = true; configuration = false; picker = value
            })
        else CreationChoiceContent(field, state, projectId, agentId, connectionId, selectedModel, effort,
            refresh = { model.loadNewModels(agentId, connectionId, refresh = true) },
            newProject = { picker = null; newProject = true }, dismiss = dismissPicker) { value ->
            when (field) {
                CreationPicker.Project -> { if (projectId != value) { permissionMode = ""; agentMode = "" }; projectId = value }
                CreationPicker.Harness -> { if (agentId != value) { permissionMode = ""; agentMode = "" }; agentId = value }
                CreationPicker.Connection -> connectionId = value
                CreationPicker.Model -> { selectedModel = value; effort = state.newModels.find { it.text("id") == value }?.let { it.text("defaultReasoningEffort").ifBlank { it.strings("reasoningEfforts").firstOrNull().orEmpty() } }.orEmpty() }
                CreationPicker.Effort -> effort = value
            }
            picker = null
            if (returnToConfiguration) { returnToConfiguration = false; configuration = true }
        }
      }
    }
    if (newProject) NewProjectSheet(state, model, close = { newProject = false }) { created -> projectId = created.id; newProject = false }
    if (modeSettings) ModeConfigurationSheet(state.modes, state.modesLoading, permissionMode, agentMode, false, false, state.error,
        refresh = { model.loadModes(agentId, projectId, true) }, close = { modeSettings = false }) { permission, mode ->
        permissionMode = permission; agentMode = mode; modeSettings = false
    }
}

@Composable internal fun NewConversationSettingsContent(harness: String, connection: String, model: String, effort: String?,
    ready: Boolean, cancel: () -> Unit, done: () -> Unit, choose: (CreationPicker) -> Unit) {
    Column(Modifier.fillMaxWidth().heightIn(max = 520.dp).padding(horizontal = 20.dp).padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("模型与设置", Modifier.weight(1f), fontSize = 20.sp, fontWeight = FontWeight.Medium)
            ActionIcon(Icons.Outlined.Close, "关闭设置", click = cancel)
        }
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            ConfigurationChoice("Harness", harness, Icons.Outlined.ViewInAr) { choose(CreationPicker.Harness) }
            ConfigurationChoice("连接", connection, Icons.Outlined.PersonOutline) { choose(CreationPicker.Connection) }
            ConfigurationChoice("模型", model, Icons.Outlined.Layers) { choose(CreationPicker.Model) }
            if (effort != null) ConfigurationChoice("推理强度", effort, Icons.Outlined.AutoAwesome) { choose(CreationPicker.Effort) }
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            NTextButton(cancel, modifier = Modifier.testTag("new-config-cancel")) { Text("取消") }
            Spacer(Modifier.weight(1f))
            NButton(done, enabled = ready, modifier = Modifier.testTag("new-config-apply")) { Text("完成") }
        }
    }
}

@Composable private fun ConfigurationChoice(label: String, value: String, icon: ImageVector, select: () -> Unit) {
    NPanel(onClick = select, color = Color.White, shape = RoundedCornerShape(16.dp)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Icon(icon, null, Modifier.size(22.dp), tint = Ink)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(label, fontSize = 12.sp, lineHeight = 16.sp, color = ComposerSecondary)
                Text(value, fontSize = 15.sp, lineHeight = 22.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Icon(Icons.Outlined.ChevronRight, null, Modifier.size(19.dp), tint = ComposerSecondary)
        }
    }
}

@Composable private fun WelcomeMark() {
    val context = LocalContext.current
    val reduce = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    val breathing = if (reduce) 1f else {
        val transition = rememberInfiniteTransition(label = "welcome-breath")
        val value by transition.animateFloat(.94f, 1.04f, infiniteRepeatable(tween(3200, easing = EaseInOutSine), RepeatMode.Reverse), label = "mark-scale")
        value
    }
    Canvas(Modifier.size(52.dp).graphicsLayer { scaleX = breathing; scaleY = breathing }) {
        val wave = Path()
        for (line in 0..2) {
            wave.reset()
            for (step in 0..60) {
                val x = size.width * (.18f + .64f * step / 60)
                val y = size.height * (.34f + .16f * line) + kotlin.math.sin(step / 60f * Math.PI * 3).toFloat() * size.height * .055f
                if (step == 0) wave.moveTo(x, y) else wave.lineTo(x, y)
            }
            drawPath(wave, Ink.copy(alpha = .8f - line * .18f), style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round))
        }
    }
}
