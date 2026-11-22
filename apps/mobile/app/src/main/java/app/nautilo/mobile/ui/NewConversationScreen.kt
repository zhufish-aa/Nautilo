@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package app.nautilo.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.animation.core.*
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
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
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
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
    val headerEngine = listOfNotNull(agent?.text("name")?.takeIf(String::isNotBlank),
        chosen?.text("displayName", selectedModel)?.takeIf(String::isNotBlank)).joinToString(" · ")
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
        Box(Modifier.fillMaxWidth().height(64.dp).background(palette.chrome).padding(horizontal = 12.dp)) {
            Box(Modifier.align(Alignment.CenterStart)) {
                ActionIcon(Icons.Outlined.ArrowBack, "返回项目") { model.navigate(Screen.Projects) }
            }
            Column(Modifier.align(Alignment.Center).padding(horizontal = 68.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                NPanel(onClick = { picker = CreationPicker.Project }, color = Color.Transparent, shape = RoundedCornerShape(7.dp)) {
                    Text(project?.name ?: "选择项目", Modifier.padding(horizontal = 6.dp), color = Ink, fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                NPanel(onClick = openConfiguration, enabled = !state.setupLoading, color = Color.Transparent, shape = RoundedCornerShape(7.dp)) {
                    Row(Modifier.padding(horizontal = 6.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(headerEngine.ifBlank { "模型与设置" }, color = Secondary, fontSize = 11.sp, fontWeight = FontWeight.Medium, maxLines = 1,
                            overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        Icon(Icons.Outlined.ExpandMore, null, Modifier.size(13.dp), tint = Secondary)
                    }
                }
            }
            NPanel(onClick = { model.navigate(Screen.Computers) }, color = palette.floating, shape = CircleShape,
                border = BorderStroke(1.dp, Line), modifier = Modifier.align(Alignment.CenterEnd).height(30.dp)) {
                Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box(Modifier.size(15.dp)) {
                        Icon(Icons.Outlined.DesktopWindows, "电脑连接", Modifier.fillMaxSize(), tint = Secondary)
                        if (state.connected) Box(Modifier.align(Alignment.BottomEnd).offset(1.dp, 1.dp).size(7.dp)
                            .background(Green, CircleShape).border(1.dp, palette.inset, CircleShape))
                    }
                    if (state.connected) state.latency?.let { Text("${it}ms", fontFamily = CodeFont, fontSize = 10.sp, color = Ink) }
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
                    Text("你说，我在听。", fontSize = 22.sp, lineHeight = 30.sp, fontWeight = FontWeight.SemiBold, color = Ink)
                    NPanel(onClick = openConfiguration, enabled = !state.setupLoading, color = palette.floating, shape = CircleShape,
                        border = BorderStroke(1.dp, palette.mirror), modifier = Modifier.testTag("starter-engine")) {
                        Row(Modifier.heightIn(min = 38.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Box(Modifier.size(6.dp).background(Accent, CircleShape))
                            Text(engine.ifEmpty { "选择模型与设置" }, color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1,
                                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                            Icon(Icons.Outlined.ExpandMore, null, Modifier.size(15.dp), tint = Secondary)
                        }
                    }
                }
            }
        }
        if (!keyboardOpen && !state.changing && state.newDraft.isBlank()) {
            LazyRow(Modifier.fillMaxWidth().padding(bottom = 4.dp), contentPadding = PaddingValues(horizontal = 14.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                itemsIndexed(listOf(
                    Triple("检视变更", "请查看当前工作区的改动，并指出需要关注的地方。", Icons.Outlined.Difference),
                    Triple("排查报错", "请帮我定位当前项目最近的报错。", Icons.Outlined.BugReport),
                    Triple("梳理结构", "请概览当前项目的目录结构和主要模块。", Icons.Outlined.AccountTree),
                )) { index, (label, prompt, icon) ->
                        MotionArrival(label, animate = true, delayMs = index * 35) {
                            NPanel(onClick = { model.newDraft(prompt); composerFocus.requestFocus(); keyboard?.show() },
                                color = palette.card, shape = RoundedCornerShape(12.dp), border = BorderStroke(1.dp, palette.mirror)) {
                                Row(Modifier.heightIn(min = 41.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                                    Icon(icon, null, Modifier.size(16.dp), tint = palette.brightAccent)
                                    Text(label, fontSize = 12.sp, fontWeight = FontWeight.Medium, color = Ink)
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
            onModes = { modeSettings = true })
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
        if (field == null) SessionSettingsContent(agent?.text("name") ?: "选择 Harness", connection?.text("name") ?: "原生配置",
            if (state.catalogLoading) "正在加载…" else chosen?.text("displayName", selectedModel) ?: "默认模型",
            effort, !state.catalogLoading, efforts = efforts, onEffortChange = { effort = it },
            team = teamSelectionName(teamId, state), cancel = cancelConfiguration, done = { configuration = false }, choose = { picker = it },
            catalog = state.newModels, modelId = selectedModel, selectModel = { id ->
                selectedModel = id
                val next = state.newModels.first { it.text("id") == id }
                effort = next.text("defaultReasoningEffort").ifBlank { next.strings("reasoningEfforts").firstOrNull().orEmpty() }
            })
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

@Composable private fun WelcomeMark() {
    val palette = MobilePalette
    val motion = LocalNautiloMotion.current
    val float = if (motion) rememberInfiniteTransition(label = "welcome-mark").animateFloat(-3f, 3f,
        infiniteRepeatable(tween(3500, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "welcome-mark-y") else null
    val shape = RoundedCornerShape(16.dp)
    val path = remember { PathParser().parsePathString("M20 12a8 8 0 1 1-8-8 6 6 0 0 1 6 6 4 4 0 0 1-4 4 2 2 0 0 1-2-2").toPath() }
    Box(Modifier.size(60.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(54.dp).graphicsLayer { translationY = (float?.value ?: 0f).dp.toPx() }
            .background(palette.card, shape).border(1.dp, palette.mirror, shape).padding(14.dp)) {
            withTransform({ scale(size.width / 24f, size.height / 24f, Offset.Zero) }) {
                drawPath(path, palette.ink, style = Stroke(1.8f, cap = StrokeCap.Round))
                drawCircle(palette.ink, 1f, Offset(12f, 12f))
            }
        }
    }
}

@Composable private fun WelcomeDots() {
    val palette = MobilePalette
    val dot = palette.dot
    val breathe = if (LocalNautiloMotion.current) rememberInfiniteTransition(label = "welcome-ambient")
        .animateFloat(.55f, 1f, infiniteRepeatable(tween(3500, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "ambient-light") else null
    Box(Modifier.fillMaxSize()) {
      Box(Modifier.matchParentSize().graphicsLayer { alpha = breathe?.value ?: .75f }.drawWithCache {
        val light = Brush.radialGradient(listOf(palette.accent.copy(alpha = if (palette.dark) .12f else .08f), Color.Transparent),
            center = Offset(size.width * .5f, size.height * .44f), radius = size.width * .72f)
        onDrawBehind { drawRect(light) }
      })
      Box(Modifier.matchParentSize().drawWithCache {
        val step = 20.dp.toPx()
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
}
