@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package app.nautilo.mobile.ui

import android.provider.Settings
import androidx.compose.animation.core.*
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
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

val WelcomeBackdrop = Brush.verticalGradient(
    0f to Color(0xFFFAFBFC), .52f to Color(0xFFF9FBFD), .82f to Color(0xFFEAF5FE), 1f to Color(0xFFC7E5FC)
)

/** Compose first, configure in context; the first send creates the native desktop session. */
@Composable fun NewConversationScreen(state: MobileState, model: MobileViewModel) {
    var projectId by rememberSaveable { mutableStateOf(state.session?.projectId ?: state.projects.firstOrNull()?.id.orEmpty()) }
    var agentId by rememberSaveable { mutableStateOf(state.session?.agentId.orEmpty()) }
    var connectionId by rememberSaveable { mutableStateOf(state.session?.connectionId.orEmpty()) }
    var selectedModel by rememberSaveable { mutableStateOf("") }
    var effort by rememberSaveable { mutableStateOf("") }
    var picker by remember { mutableStateOf<CreationPicker?>(null) }
    var newProject by remember { mutableStateOf(false) }
    var more by remember { mutableStateOf(false) }
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
        selectedModel = ""; effort = ""
        if (agentId.isNotEmpty()) model.loadNewModels(agentId, connectionId)
    }
    LaunchedEffect(state.newModels) {
        val previous = state.session?.takeIf { it.agentId == agentId && it.connectionId == connectionId }
        val choice = state.newModels.find { it.text("id") == previous?.model } ?: state.newModels.firstOrNull()
        choice?.let {
            selectedModel = it.text("id")
            effort = previous?.effort?.takeIf { value -> value in it.strings("reasoningEfforts") } ?: it.text("defaultReasoningEffort")
        }
    }
    val canSend = state.newDraft.isNotBlank() && state.connected && !state.changing && !state.setupLoading &&
        !state.catalogLoading && project != null && agent != null
    val send = {
        if (canSend) model.createSession(projectId, agentId, connectionId, selectedModel, effort, firstMessage = state.newDraft)
        Unit
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        Row(Modifier.fillMaxWidth().height(64.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            ActionIcon(Icons.Outlined.ArrowBack, "返回项目") { model.navigate(Screen.Projects) }
            Surface(onClick = { picker = CreationPicker.Project }, color = Color.Transparent, shape = RoundedCornerShape(12.dp), modifier = Modifier.weight(1f)) {
                Row(Modifier.padding(horizontal = 10.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(project?.name ?: "选择项目", fontSize = 19.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, false))
                    Icon(Icons.Outlined.ExpandMore, null, Modifier.padding(start = 6.dp).size(18.dp), tint = Secondary)
                }
            }
            Surface(onClick = { model.navigate(Screen.Computers) }, color = Selection.copy(alpha = .75f), shape = CircleShape, modifier = Modifier.size(40.dp)) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.DesktopWindows, "电脑连接", Modifier.size(19.dp), tint = Ink)
                    Dot(state.connected, Modifier.align(Alignment.BottomEnd).padding(6.dp))
                }
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            androidx.compose.animation.AnimatedVisibility(visible = !WindowInsets.isImeVisible, enter = fadeIn(tween(180)) + scaleIn(tween(260, easing = CubicBezierEasing(.23f, 1f, .32f, 1f)), initialScale = .96f),
                exit = fadeOut(tween(120)) + scaleOut(tween(180), targetScale = .96f)) {
            Column(Modifier.offset(y = (-12).dp).padding(horizontal = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(20.dp)) {
                WelcomeMark()
                Text("你说，我在听。", fontSize = 28.sp, lineHeight = 38.sp, fontWeight = FontWeight.Medium, color = Ink)
            }
            }
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                WelcomeChip(Icons.Outlined.ViewInAr, agent?.text("name") ?: "选择 Harness", Modifier.weight(1f, false)) { picker = CreationPicker.Harness }
                Spacer(Modifier.width(8.dp))
                WelcomeChip(Icons.Outlined.PersonOutline, connection?.text("name") ?: "原生配置", Modifier.weight(1f, false)) { picker = CreationPicker.Connection }
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Surface(onClick = { picker = CreationPicker.Model }, color = Color.Transparent, shape = RoundedCornerShape(10.dp), modifier = Modifier.weight(1f)) {
                    Row(Modifier.padding(vertical = 10.dp, horizontal = 5.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (state.catalogLoading) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp, color = Secondary)
                        else Icon(Icons.Outlined.Layers, null, Modifier.size(16.dp), tint = Ink)
                        Text(chosen?.text("displayName", selectedModel) ?: "默认模型", fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, false))
                        Icon(Icons.Outlined.ExpandMore, null, Modifier.size(14.dp), tint = Secondary)
                    }
                }
                if (efforts.isNotEmpty()) TextButton(onClick = { picker = CreationPicker.Effort }, contentPadding = PaddingValues(horizontal = 7.dp)) {
                    Text("推理 " + effortName(effort), fontSize = 12.sp, color = Ink)
                    Icon(Icons.Outlined.ExpandMore, null, Modifier.padding(start = 4.dp).size(14.dp), tint = Secondary)
                }
            }
            Surface(shape = RoundedCornerShape(32.dp), color = Color.White, shadowElevation = 3.dp, tonalElevation = 0.dp) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box {
                        ActionIcon(Icons.Outlined.Add, "新建与设置", !state.changing) { more = true }
                        DropdownMenu(expanded = more, onDismissRequest = { more = false }) {
                            DropdownMenuItem(text = { Text("新建项目") }, leadingIcon = { Icon(Icons.Outlined.CreateNewFolder, null) }, onClick = { more = false; newProject = true })
                            DropdownMenuItem(text = { Text("选择项目") }, leadingIcon = { Icon(Icons.Outlined.FolderOpen, null) }, onClick = { more = false; picker = CreationPicker.Project })
                        }
                    }
                    BasicTextField(value = state.newDraft, onValueChange = model::newDraft, enabled = !state.changing,
                        modifier = Modifier.weight(1f).heightIn(min = 44.dp, max = 140.dp).padding(horizontal = 4.dp, vertical = 7.dp), maxLines = 5,
                        textStyle = TextStyle(color = Ink, fontSize = 16.sp, lineHeight = 24.sp), cursorBrush = SolidColor(Blue),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send), keyboardActions = KeyboardActions(onSend = { send() }),
                        decorationBox = { field -> Box(contentAlignment = Alignment.CenterStart) { if (state.newDraft.isEmpty()) Text("问问 Nautilo", color = Secondary, fontSize = 16.sp); field() } })
                    ActionIcon(Icons.Outlined.MicNone, "语音输入", !state.changing, voice)
                    if (state.changing) Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(21.dp), strokeWidth = 2.dp) }
                    else if (state.newDraft.isBlank()) FilledIconButton(onClick = voice, modifier = Modifier.size(42.dp), colors = IconButtonDefaults.filledIconButtonColors(containerColor = Selection, contentColor = Ink)) {
                        Icon(Icons.Outlined.GraphicEq, "语音输入", Modifier.size(24.dp))
                    } else SendAction(canSend, send)
                }
            }
        }
    }
    picker?.let { field -> CreationChoiceSheet(field, state, projectId, agentId, connectionId, selectedModel, effort,
        refresh = { model.loadNewModels(agentId, connectionId, refresh = true) },
        newProject = { picker = null; newProject = true }, dismiss = { picker = null }) { value ->
            when (field) {
                CreationPicker.Project -> projectId = value
                CreationPicker.Harness -> agentId = value
                CreationPicker.Connection -> connectionId = value
                CreationPicker.Model -> { selectedModel = value; effort = state.newModels.find { it.text("id") == value }?.text("defaultReasoningEffort").orEmpty() }
                CreationPicker.Effort -> effort = value
            }
            picker = null
        }
    }
    if (newProject) NewProjectSheet(state, model, close = { newProject = false }) { created -> projectId = created.id; newProject = false }
}

@Composable private fun WelcomeChip(icon: ImageVector, text: String, modifier: Modifier, select: () -> Unit) {
    Surface(onClick = select, modifier = modifier, color = Color.White.copy(alpha = .64f), shape = RoundedCornerShape(18.dp)) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(icon, null, Modifier.size(15.dp), tint = Ink)
            Text(text, fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, false))
            Icon(Icons.Outlined.ExpandMore, null, Modifier.size(13.dp), tint = Secondary)
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
        drawCircle(Brush.radialGradient(listOf(Color(0xFFD3EDFF), Color(0xFFEBF6FF).copy(alpha = .0f))), radius = size.width / 2)
        val wave = Path()
        for (line in 0..2) {
            wave.reset()
            for (step in 0..60) {
                val x = size.width * (.18f + .64f * step / 60)
                val y = size.height * (.34f + .16f * line) + kotlin.math.sin(step / 60f * Math.PI * 3).toFloat() * size.height * .055f
                if (step == 0) wave.moveTo(x, y) else wave.lineTo(x, y)
            }
            drawPath(wave, Brush.horizontalGradient(listOf(Color(0xFF79BCEB), Blue, Color(0xFF559BD1))), style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2.4.dp.toPx(), cap = StrokeCap.Round))
        }
    }
}
