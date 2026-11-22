@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package app.nautilo.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.animation.core.*
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
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
    var teamId by rememberSaveable(state.host?.id) { mutableStateOf("") }
    var modeSettings by remember { mutableStateOf(false) }
    var picker by remember { mutableStateOf<CreationPicker?>(null) }
    var newProject by remember { mutableStateOf(false) }
    var configuration by remember { mutableStateOf(false) }
    var configurationBefore by remember { mutableStateOf(listOf("", "", "", "", "", "", "")) }
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val composerFocus = remember { FocusRequester() }
    val palette = MobilePalette
    val motion = LocalNautiloMotion.current
    val keyboardOpen = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { model.addAttachments(it, newConversation = true) }
    val agents = state.setup.objects("agents")
    val connections = state.setup.objects("connections")
    val project = state.projects.find { it.id == projectId }
    val agent = agents.find { it.text("id") == agentId }
    val connection = connections.find { it.text("id") == connectionId }
    val chosen = state.newModels.find { it.text("id") == selectedModel }
    val efforts = chosen?.strings("reasoningEfforts").orEmpty()
    val engine = listOfNotNull(agent?.text("name")?.takeIf(String::isNotBlank),
        chosen?.text("displayName", selectedModel)?.takeIf(String::isNotBlank),
        effortName(effort).takeIf { effort in efforts && it.isNotBlank() }).joinToString(" · ")
    val openConfiguration = {
        focus.clearFocus()
        keyboard?.hide()
        configurationBefore = listOf(agentId, connectionId, selectedModel, effort, permissionMode, agentMode, teamId)
        configuration = true
    }
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
        if (canSend) model.createSession(projectId, agentId, connectionId, selectedModel, effort, firstMessage = state.newDraft, permissionMode = permissionMode, agentMode = agentMode, teamId = teamId)
        Unit
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        Row(Modifier.fillMaxWidth().height(56.dp).background(palette.chrome).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            ActionIcon(Icons.Outlined.ArrowBack, "返回项目") { model.navigate(Screen.Projects) }
            NPanel(onClick = { picker = CreationPicker.Project }, color = Color.Transparent, shape = RoundedCornerShape(12.dp), modifier = Modifier.weight(1f)) {
                Row(Modifier.padding(horizontal = 10.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(project?.name ?: "选择项目", fontSize = 18.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, false))
                    Icon(Icons.Outlined.ExpandMore, null, Modifier.padding(start = 6.dp).size(18.dp), tint = Secondary)
                }
            }
            NPanel(onClick = { model.navigate(Screen.Computers) }, color = palette.inset, shape = CircleShape, modifier = Modifier.size(36.dp)) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Box(Modifier.size(19.dp)) {
                        Icon(Icons.Outlined.DesktopWindows, "电脑连接", Modifier.fillMaxSize(), tint = Ink)
                        if (state.connected) Box(Modifier.align(Alignment.BottomEnd).offset(1.dp, 1.dp).size(7.dp)
                            .background(palette.green, CircleShape).border(1.dp, palette.inset, CircleShape))
                    }
                }
            }
        }
        NDivider()
        Box(Modifier.weight(1f).fillMaxWidth().clickable(indication = null, interactionSource = remember { MutableInteractionSource() }) { focus.clearFocus(); keyboard?.hide() }, contentAlignment = Alignment.Center) {
            androidx.compose.animation.AnimatedVisibility(visible = !keyboardOpen && !state.changing,
                modifier = Modifier.matchParentSize(), enter = fadeIn(tween(if (motion) 240 else 0)), exit = fadeOut(tween(if (motion) 200 else 0))) {
                WelcomeDots()
            }
            androidx.compose.animation.AnimatedVisibility(visible = !keyboardOpen && !state.changing,
                enter = fadeIn(tween(if (motion) 220 else 0)) + slideInVertically(tween(if (motion) 220 else 0, easing = MotionEase)) { it / 10 },
                exit = fadeOut(tween(if (motion) 160 else 0)) + slideOutVertically(tween(if (motion) 180 else 0, easing = MotionEase)) { -it / 9 }) {
                Column(Modifier.padding(horizontal = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    WelcomeMark()
                    Text("你说，我在听。", fontSize = 21.sp, lineHeight = 30.sp, fontWeight = FontWeight.Medium, color = Ink)
                    NPanel(onClick = openConfiguration, enabled = !state.setupLoading, color = palette.card, shape = CircleShape,
                        border = BorderStroke(1.dp, Line), modifier = Modifier.testTag("starter-engine")) {
                        Row(Modifier.heightIn(min = 38.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Icon(Icons.Outlined.Tune, null, Modifier.size(15.dp), tint = Accent)
                            Text(engine.ifEmpty { "选择模型与设置" }, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                            Icon(Icons.Outlined.ExpandMore, null, Modifier.size(15.dp), tint = Secondary)
                        }
                    }
                }
            }
        }
        if (!keyboardOpen && !state.changing && state.newDraft.isBlank()) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 14.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("查看项目结构" to "请概览当前项目的结构和主要模块。", "排查问题" to "请帮我排查当前项目里的问题。", "补充测试" to "请检查当前项目里最需要补充的测试。")
                    .forEachIndexed { index, (label, prompt) ->
                        MotionArrival(label, animate = true, delayMs = index * 35) {
                            NPanel(onClick = { model.newDraft(prompt); composerFocus.requestFocus(); keyboard?.show() },
                                color = palette.card, shape = CircleShape, border = BorderStroke(1.dp, Line)) {
                                Row(Modifier.heightIn(min = 36.dp).padding(horizontal = 11.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                                    Icon(Icons.Outlined.Bolt, null, Modifier.size(14.dp), tint = Accent)
                                    Text(label, fontSize = 12.sp, color = Secondary)
                                }
                            }
                        }
                    }
            }
        }
        ChatComposer(text = state.newDraft, onText = model::newDraft, placeholder = "发送消息", enabled = !state.changing,
            canSend = canSend, busy = state.changing, attachments = state.newAttachments, attachmentBusy = state.attachmentLoading,
            onAttach = { files.launch(arrayOf("*/*")) }, onRemoveAttachment = { model.removeAttachment(it, newConversation = true) }, onVoice = voice, onSend = send,
            configurationEnabled = !state.setupLoading && !state.changing, onConfiguration = openConfiguration,
            inputFocusRequester = composerFocus, alwaysShowTools = true, modesSelected = permissionMode.isNotBlank() || agentMode.isNotBlank(),
            onModes = if ("session.modes" in state.capabilities) { { modeSettings = true } } else null)
    }
    val cancelConfiguration = {
        agentId = configurationBefore[0]; connectionId = configurationBefore[1]
        selectedModel = configurationBefore[2]; effort = configurationBefore[3]
        permissionMode = configurationBefore[4]; agentMode = configurationBefore[5]
        teamId = configurationBefore[6]
        picker = null
        configuration = false
    }
    // One window owns the whole flow; pickers never replay the sheet entrance
    // or transfer keyboard focus to a second overlapping dialog.
    if (configuration || picker != null) NSheet(onDismissRequest = { if (configuration) cancelConfiguration() else picker = null }) {
      BackHandler(configuration && picker != null) { picker = null }
      MotionPage(picker) { field ->
        if (field == null) NewConversationSettingsContent(agent?.text("name") ?: "选择 Harness", connection?.text("name") ?: "原生配置",
            if (state.catalogLoading) "正在加载…" else chosen?.text("displayName", selectedModel) ?: "默认模型",
            effort, !state.catalogLoading, efforts = efforts, onEffortChange = { effort = it },
            team = teamSelectionName(teamId, state), cancel = cancelConfiguration, done = { configuration = false }, choose = { picker = it })
        else CreationChoiceContent(field, state, when (field) {
            CreationPicker.Project -> projectId
            CreationPicker.Harness -> agentId
            CreationPicker.Connection -> connectionId
            CreationPicker.Model -> selectedModel
            CreationPicker.Team -> teamId
        },
            refresh = { if (field == CreationPicker.Team) model.loadSetup() else model.loadNewModels(agentId, connectionId, refresh = true) },
            newProject = { picker = null; newProject = true }, dismiss = { picker = null }) { value ->
            when (field) {
                CreationPicker.Project -> { if (projectId != value) { permissionMode = ""; agentMode = "" }; projectId = value }
                CreationPicker.Harness -> { if (agentId != value) { permissionMode = ""; agentMode = "" }; agentId = value }
                CreationPicker.Connection -> connectionId = value
                CreationPicker.Model -> { selectedModel = value; effort = state.newModels.find { it.text("id") == value }?.let { it.text("defaultReasoningEffort").ifBlank { it.strings("reasoningEfforts").firstOrNull().orEmpty() } }.orEmpty() }
                CreationPicker.Team -> teamId = value
            }
            picker = null
        }
      }
    }
    if (newProject) NewProjectSheet(state, model, close = { newProject = false }) { created -> projectId = created.id; newProject = false }
    if (modeSettings) ModeConfigurationSheet(state.modes, state.modesLoading, permissionMode, agentMode, false, false, state.error,
        refresh = { model.loadModes(agentId, projectId, true) }, close = { modeSettings = false }) { permission, mode ->
        permissionMode = permission; agentMode = mode; modeSettings = false
    }
}

@Composable internal fun NewConversationSettingsContent(harness: String, connection: String, model: String, effort: String,
    ready: Boolean, efforts: List<String>, onEffortChange: (String) -> Unit, team: String = "独立工作", cancel: () -> Unit, done: () -> Unit, choose: (CreationPicker) -> Unit) {
    Column(Modifier.fillMaxWidth().heightIn(max = 420.dp).padding(horizontal = 20.dp).padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("模型与设置", Modifier.weight(1f), fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            ActionIcon(Icons.Outlined.Close, "关闭设置", click = cancel)
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            NPanel(color = MobilePalette.group, shape = RoundedCornerShape(14.dp)) {
                Column {
                    ConfigurationChoice("Harness", harness, Icons.Outlined.ViewInAr) { choose(CreationPicker.Harness) }
                    NDivider(Modifier.padding(horizontal = 13.dp))
                    ConfigurationChoice("连接", connection, Icons.Outlined.PersonOutline) { choose(CreationPicker.Connection) }
                    NDivider(Modifier.padding(horizontal = 13.dp))
                    ConfigurationChoice("模型", model, Icons.Outlined.Layers) { choose(CreationPicker.Model) }
                    NDivider(Modifier.padding(horizontal = 13.dp))
                    ConfigurationChoice("协作团队", team, Icons.Outlined.Groups) { choose(CreationPicker.Team) }
                }
            }
            ReasoningEffortControl(efforts, effort, ready, onEffortChange)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            NButton(cancel, modifier = Modifier.weight(1f).testTag("new-config-cancel"), shape = CircleShape,
                colors = ButtonDefaults.buttonColors(containerColor = MobilePalette.group, contentColor = Ink)) { Text("取消") }
            NButton(done, enabled = ready, modifier = Modifier.weight(1f).testTag("new-config-apply"), shape = CircleShape) { Text("完成") }
        }
    }
}

@Composable internal fun ConfigurationChoice(label: String, value: String, icon: ImageVector,
    enabled: Boolean = true, modifier: Modifier = Modifier, select: (() -> Unit)? = null) {
    NPanel(onClick = select, enabled = enabled, modifier = modifier, color = Color.Transparent, shape = RoundedCornerShape(10.dp)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 53.dp).padding(horizontal = 13.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
            Icon(icon, null, Modifier.size(18.dp), tint = Secondary)
            Text(label, fontSize = 13.sp, maxLines = 1)
            Text(value, fontSize = 13.sp, color = if (enabled || select == null) Ink else Secondary, maxLines = 1,
                overflow = TextOverflow.Ellipsis, textAlign = TextAlign.End, modifier = Modifier.weight(1f))
            if (select != null) Icon(Icons.Outlined.ChevronRight, null, Modifier.size(15.dp), tint = Secondary)
        }
    }
}

@Composable private fun WelcomeMark() {
    val palette = MobilePalette
    val motion = LocalNautiloMotion.current
    val breathing = if (motion) rememberInfiniteTransition(label = "welcome-halo").animateFloat(.40f, .75f,
        infiniteRepeatable(tween(2600), RepeatMode.Reverse), label = "welcome-halo-alpha") else null
    val shape = RoundedCornerShape(13.dp)
    val path = remember { PathParser().parsePathString("M20 12a8 8 0 1 1-8-8 6 6 0 0 1 6 6 4 4 0 0 1-4 4 2 2 0 0 1-2-2").toPath() }
    Box(Modifier.size(56.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.matchParentSize().graphicsLayer { alpha = breathing?.value ?: .4f }
            .background(Brush.radialGradient(listOf(palette.tint, Color.Transparent)), CircleShape))
        Canvas(Modifier.size(44.dp).background(palette.card, shape).border(1.dp, palette.edge, shape).padding(10.dp)) {
            withTransform({ scale(size.width / 24f, size.height / 24f, Offset.Zero) }) {
                drawPath(path, palette.ink, style = Stroke(1.8f, cap = StrokeCap.Round))
                drawCircle(palette.ink, 1f, Offset(12f, 12f))
            }
        }
    }
}

@Composable private fun WelcomeDots() {
    val dot = MobilePalette.dot
    Box(Modifier.fillMaxSize().drawWithCache {
        val step = 22.dp.toPx()
        val radius = 1.dp.toPx()
        val width = size.width
        val height = size.height
        val points = buildList {
            for (row in 0..(height / step).toInt()) for (column in 0..(width / step).toInt()) {
                val point = Offset((column + .5f) * step, (row + .5f) * step)
                val x = (point.x - width * .5f) / (width * .55f)
                val y = (point.y - height * .48f) / (height * .6f)
                val opacity = (1f - x * x - y * y).coerceAtLeast(0f)
                if (opacity > 0f) add(point to opacity * opacity)
            }
        }
        onDrawBehind { points.forEach { (point, opacity) -> drawCircle(dot.copy(alpha = dot.alpha * opacity), radius, point) } }
    })
}
