@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package app.nautilo.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.MobileViewModel
import app.nautilo.mobile.data.*

@Composable fun SessionConfigurationSheet(state: MobileState, model: MobileViewModel, close: () -> Unit) {
    SessionConfigurationEditor(state, model, close) { content ->
        NSheet(onDismissRequest = { if (!state.changing) close() }) { content() }
    }
}

@Composable internal fun SessionConfigurationEditor(state: MobileState, model: MobileViewModel, close: () -> Unit,
    container: @Composable (@Composable () -> Unit) -> Unit) {
    val session = state.session ?: return
    var selectedConnection by remember(session.id) { mutableStateOf(session.connectionId) }
    var selectedModel by remember(session.id) { mutableStateOf(session.model) }
    var selectedEffort by remember(session.id) { mutableStateOf(session.effort) }
    var selectedTeam by remember(session.id) { mutableStateOf(session.teamId) }
    var page by remember(session.id) { mutableStateOf<CreationPicker?>(null) }
    var confirmSwitch by remember(session.id) { mutableStateOf(false) }
    val switching = selectedConnection != session.connectionId
    val catalog = if (switching) state.newModels else state.models
    val loading = if (switching) state.catalogLoading else state.modelsLoading
    val connection = state.setup.objects("connections").find { it.text("id") == selectedConnection }
    val harness = state.setup.objects("agents").find { it.text("id") == session.agentId }?.text("name")?.takeIf(String::isNotBlank)
    val chosen = catalog.find { it.text("id") == selectedModel }
    val efforts = chosen?.strings("reasoningEfforts").orEmpty()
    val active = running(state.runStatus)
    val editable = state.connected && !state.changing && !active
    val teamChanged = selectedTeam != session.teamId
    val modelChanged = switching || selectedModel != session.model || selectedEffort != session.effort
    val changed = modelChanged || teamChanged
    LaunchedEffect(session.id) {
        model.clearError()
        if (state.setup.length() == 0) model.loadSetup()
        if (state.models.isEmpty()) model.loadModels()
    }
    LaunchedEffect(catalog) {
        if (catalog.isNotEmpty() && chosen == null) catalog.first().let {
            selectedModel = it.text("id")
            selectedEffort = it.text("defaultReasoningEffort").ifBlank { it.strings("reasoningEfforts").firstOrNull().orEmpty() }
        }
    }
    val refreshModels = {
        if (switching) model.loadNewModels(session.agentId, selectedConnection, refresh = true) else model.loadModels(refresh = true)
        Unit
    }
    val apply = {
        model.configure(selectedModel, selectedEffort, selectedConnection.takeIf { switching }, confirmChange = switching,
            teamId = selectedTeam.takeIf { teamChanged }, configured = close)
    }

    container {
        BackHandler(page != null) { page = null }
        MotionPage(page) { current ->
            val back = { page = null }
            when (current) {
                CreationPicker.Team -> TeamChoiceContent(state, selectedTeam, model::loadSetup, back) { selectedTeam = it; back() }
                CreationPicker.Connection -> CreationChoiceContent(current, state, selectedConnection, {}, {}, back) { id ->
                    if (id != selectedConnection) {
                        selectedConnection = id
                        if (id != session.connectionId) model.loadNewModels(session.agentId, id)
                        else { selectedModel = session.model; selectedEffort = session.effort }
                    }
                    back()
                }
                CreationPicker.Model -> CreationChoiceContent(current, state.copy(newModels = catalog, catalogLoading = loading), selectedModel,
                    refreshModels, {}, back, selectionEnabled = editable && !loading) { id ->
                    if (id != selectedModel) {
                        val next = catalog.first { it.text("id") == id }
                        selectedModel = id
                        selectedEffort = next.text("defaultReasoningEffort").ifBlank { next.strings("reasoningEfforts").firstOrNull().orEmpty() }
                    }
                    back()
                }
                else -> Column(Modifier.fillMaxSize().padding(horizontal = 20.dp).padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("模型与设置", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        ActionIcon(Icons.Outlined.Close, "关闭设置", !state.changing, close)
                    }
                    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).testTag("session-config-settings"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        NPanel(color = MobilePalette.group, shape = RoundedCornerShape(14.dp)) {
                            Column {
                                if (harness != null) {
                                    ConfigurationChoice("Harness", harness, Icons.Outlined.ViewInAr)
                                    NDivider(Modifier.padding(horizontal = 13.dp))
                                }
                                ConfigurationChoice("连接", connection?.text("name") ?: "原生配置", Icons.Outlined.PersonOutline, enabled = editable) { page = CreationPicker.Connection }
                                NDivider(Modifier.padding(horizontal = 13.dp))
                                ConfigurationChoice("模型", chosen?.text("displayName", selectedModel) ?: selectedModel.ifBlank { "默认模型" },
                                    Icons.Outlined.Layers, enabled = !state.changing) { page = CreationPicker.Model }
                                NDivider(Modifier.padding(horizontal = 13.dp))
                                ConfigurationChoice("协作团队", teamSelectionName(selectedTeam, state), Icons.Outlined.Groups,
                                    enabled = editable && session.parentSessionId.isEmpty() && "session.team" in state.capabilities,
                                    modifier = Modifier.testTag("session-config-team")) { page = CreationPicker.Team }
                            }
                        }
                        if (active) Text("当前轮结束后可切换账号、API 和模型", fontSize = 12.sp, color = Secondary)
                        ReasoningEffortControl(efforts, selectedEffort, editable && !loading) { selectedEffort = it }
                        if (state.error.isNotBlank()) Text(state.error, fontSize = 13.sp, color = Danger)
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        NButton(close, modifier = Modifier.weight(1f).testTag("session-config-cancel"), enabled = !state.changing,
                            shape = CircleShape, colors = ButtonDefaults.buttonColors(containerColor = MobilePalette.group, contentColor = Ink)) { Text("取消") }
                        NButton(onClick = {
                            if (!changed) close()
                            else if (switching && (state.messages.isNotEmpty() || state.runs.isNotEmpty())) confirmSwitch = true
                            else apply()
                        }, enabled = !state.changing && (!changed || (editable && (!modelChanged || (!loading && chosen != null)))),
                            modifier = Modifier.weight(1f).testTag("session-config-apply"), shape = CircleShape) {
                            if (state.changing) {
                                NSpinner(Modifier.size(16.dp), strokeWidth = 1.6.dp, color = MobilePalette.onPrimary)
                                Spacer(Modifier.width(6.dp))
                            }
                            Text(if (state.changing) "正在应用…" else "完成")
                        }
                    }
                }
            }
        }
    }
    if (confirmSwitch) NAlert(onDismissRequest = { confirmSwitch = false }, title = { Text("切换连接？") },
        text = { Text("聊天记录会保留。更换连接会重新建立会话，之前的推理、缓存和图片上下文不会迁移。") },
        confirmButton = { NButton(onClick = { confirmSwitch = false; apply() }) { Text("切换连接") } },
        dismissButton = { NTextButton(onClick = { confirmSwitch = false }) { Text("取消") } })
}

private val EffortEase = CubicBezierEasing(.34f, 1.35f, .64f, 1f)

@Composable internal fun ReasoningEffortControl(efforts: List<String>, value: String, enabled: Boolean, select: (String) -> Unit) {
    if (efforts.isEmpty()) return
    val palette = MobilePalette
    val index = efforts.indexOf(value)
    val position = animateFloatAsState(index.coerceAtLeast(0).toFloat(),
        tween(if (LocalNautiloMotion.current) 240 else 0, easing = EffortEase), label = "reasoning-effort")
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("推理强度", fontSize = 12.sp, color = Secondary)
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val segment = maxOf(44.dp, (maxWidth - 6.dp) / efforts.size)
            val shape = RoundedCornerShape(9.dp)
            Box(Modifier.horizontalScroll(rememberScrollState()).width(segment * efforts.size + 6.dp)
                .height(44.dp).background(palette.inset, shape).border(1.dp, Line, shape).padding(3.dp)) {
                if (index >= 0) Box(Modifier.width(segment).fillMaxHeight()
                    .graphicsLayer { translationX = segment.toPx() * position.value }
                    .background(palette.tint, RoundedCornerShape(7.dp))
                    .border(1.dp, palette.accent.copy(alpha = .34f), RoundedCornerShape(7.dp)))
                Row(Modifier.fillMaxSize().selectableGroup()) {
                    efforts.forEach { item ->
                        Box(Modifier.width(segment).fillMaxHeight().selectable(
                            selected = item == value, enabled = enabled, role = Role.RadioButton, onClick = { select(item) }),
                            contentAlignment = Alignment.Center) {
                            Text(effortName(item), Modifier.padding(horizontal = 4.dp), fontSize = 12.sp,
                                color = if (item == value) Ink else Secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
    }
}
