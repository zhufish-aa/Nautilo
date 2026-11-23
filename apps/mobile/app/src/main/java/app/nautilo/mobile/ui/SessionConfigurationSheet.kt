@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package app.nautilo.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.*
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.MobileViewModel
import app.nautilo.mobile.data.*
import org.json.JSONObject

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
    val selectModel: (String) -> Unit = { id ->
        if (id != selectedModel) {
            val next = catalog.first { it.text("id") == id }
            selectedModel = id
            selectedEffort = next.text("defaultReasoningEffort").ifBlank { next.strings("reasoningEfforts").firstOrNull().orEmpty() }
        }
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
                    selectModel(id)
                    back()
                }
                else -> SessionSettingsContent(
                    harness = harness.orEmpty(), connection = connection?.text("name") ?: "原生配置",
                    model = chosen?.text("displayName", selectedModel) ?: selectedModel.ifBlank { "默认模型" },
                    effort = selectedEffort, ready = !state.changing && (!changed || (editable && (!modelChanged || (!loading && chosen != null)))),
                    efforts = efforts, onEffortChange = { selectedEffort = it }, team = teamSelectionName(selectedTeam, state),
                    cancel = close, done = {
                        if (!changed) close()
                        else if (switching && (state.timeline?.blocks.orEmpty().isNotEmpty() || state.runs.isNotEmpty())) confirmSwitch = true
                        else apply()
                    }, choose = { page = it }, catalog = catalog, modelId = selectedModel, selectModel = selectModel,
                    newSession = false, saving = state.changing, modelEditable = editable && !loading,
                    connectionEditable = editable, teamEditable = editable && session.parentSessionId.isEmpty() && "session.team" in state.capabilities,
                    locked = active, error = state.error)
            }
        }
    }
    if (confirmSwitch) NAlert(onDismissRequest = { confirmSwitch = false }, title = { Text("切换连接？") },
        text = { Text("聊天记录会保留。更换连接会重新建立会话，之前的推理、缓存和图片上下文不会迁移。") },
        confirmButton = { NButton(onClick = { confirmSwitch = false; apply() }) { Text("切换连接") } },
        dismissButton = { NTextButton(onClick = { confirmSwitch = false }) { Text("取消") } })
}

@Composable internal fun SessionSettingsContent(
    harness: String, connection: String, model: String, effort: String,
    ready: Boolean, efforts: List<String>, onEffortChange: (String) -> Unit, team: String = "独立工作",
    cancel: () -> Unit, done: () -> Unit, choose: (CreationPicker) -> Unit,
    catalog: List<JSONObject> = emptyList(), modelId: String = "", selectModel: (String) -> Unit = {},
    newSession: Boolean = true, saving: Boolean = false, modelEditable: Boolean = ready,
    connectionEditable: Boolean = true, teamEditable: Boolean = true, locked: Boolean = false, error: String = "",
) {
    val palette = MobilePalette
    val prefix = if (newSession) "new-config" else "session-config"
    Column(Modifier.fillMaxWidth().heightIn(max = 500.dp)) {
        Box(Modifier.fillMaxWidth().height(44.dp).padding(horizontal = 16.dp)) {
            NPanel(onClick = cancel, enabled = !saving, color = Color.Transparent, shape = CircleShape,
                modifier = Modifier.align(Alignment.CenterStart).height(44.dp).widthIn(min = 48.dp).testTag("$prefix-cancel")) {
                Box(Modifier.padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
                    Text("取消", fontSize = 13.sp, color = Secondary)
                }
            }
            Text("模型与设置", Modifier.align(Alignment.Center), color = Ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            NPanel(onClick = done, enabled = ready, color = Color.Transparent, shape = CircleShape,
                modifier = Modifier.align(Alignment.CenterEnd).height(44.dp).widthIn(min = 48.dp).testTag("$prefix-apply")) {
                Box(contentAlignment = Alignment.Center) {
                    Row(Modifier.height(30.dp).background(if (ready) palette.primary else palette.inset, CircleShape)
                        .padding(horizontal = 13.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        if (saving) NSpinner(Modifier.size(13.dp), strokeWidth = 1.5.dp)
                        Text(if (saving) "应用中" else "完成", color = if (ready) palette.onPrimary else Secondary,
                            fontSize = 12.sp, fontWeight = FontWeight.Medium)
                    }
                }
            }
        }
        NDivider(Modifier.padding(top = 4.dp))
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())
            .testTag("$prefix-settings").padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            NPanel(shape = RoundedCornerShape(18.dp), border = BorderStroke(1.dp, Accent.copy(alpha = .30f))) {
                Column(Modifier.fillMaxWidth()) {
                    NPanel(onClick = { choose(CreationPicker.Model) }, enabled = !saving, color = Color.Transparent,
                        modifier = Modifier.testTag("config-model-picker")) {
                        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Box(Modifier.size(34.dp).background(Selection, RoundedCornerShape(9.dp)), contentAlignment = Alignment.Center) {
                                Icon(Icons.Outlined.Bolt, null, Modifier.size(20.dp), tint = palette.brightAccent)
                            }
                            Column(Modifier.weight(1f)) {
                                Text("当前模型", color = Secondary, fontSize = 11.sp)
                                Text(model, color = Ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            Text("切换", color = palette.brightAccent, fontSize = 12.sp)
                            Icon(Icons.Outlined.ChevronRight, null, Modifier.size(15.dp), tint = palette.brightAccent)
                        }
                    }
                    if (catalog.size > 1) {
                        NDivider(Modifier.padding(horizontal = 12.dp))
                        LazyRow(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                            horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                            items(catalog) { item ->
                                val id = item.text("id")
                                val selected = id == modelId
                                NPanel(onClick = { selectModel(id) }, enabled = modelEditable, shape = CircleShape,
                                    color = if (selected) Accent.copy(alpha = if (palette.dark) .18f else .085f) else Color.Transparent,
                                    border = BorderStroke(1.dp, if (selected) Accent.copy(alpha = .40f) else Line)) {
                                    Row(Modifier.height(29.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                                        if (selected) Box(Modifier.size(5.dp).background(Accent, CircleShape))
                                        Text(item.text("displayName", id), Modifier.widthIn(max = 140.dp),
                                            color = if (selected) palette.brightAccent else Ink,
                                            fontSize = 11.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if (harness.isNotBlank()) NPanel(onClick = if (newSession) ({ choose(CreationPicker.Harness) }) else null,
                shape = RoundedCornerShape(12.dp), border = BorderStroke(1.dp, palette.mirror)) {
                Row(Modifier.fillMaxWidth().heightIn(min = 37.dp).padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    Icon(Icons.Outlined.ViewInAr, null, Modifier.size(16.dp), tint = Secondary)
                    Text("Harness", Modifier.weight(1f), color = Secondary, fontSize = 11.sp)
                    Text(harness, Modifier.weight(1.35f), color = Ink, fontSize = 12.sp, textAlign = TextAlign.End,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (newSession) Icon(Icons.Outlined.ChevronRight, null, Modifier.size(15.dp), tint = Secondary)
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                ConfigurationTile("连接配置", connection, Icons.Outlined.PersonOutline, Modifier.weight(1f), connectionEditable) {
                    choose(CreationPicker.Connection)
                }
                ConfigurationTile("协作团队", team, Icons.Outlined.Groups, Modifier.weight(1f).testTag("session-config-team"), teamEditable) {
                    choose(CreationPicker.Team)
                }
            }
            ReasoningEffortControl(efforts, effort, modelEditable, onEffortChange)
            if (locked) Text("当前轮结束后可切换账号、API 和模型", fontSize = 12.sp, color = Secondary)
            if (error.isNotBlank()) Text(error, fontSize = 13.sp, color = Danger)
        }
    }
}

@Composable private fun ConfigurationTile(label: String, value: String, icon: ImageVector, modifier: Modifier, enabled: Boolean, select: () -> Unit) {
    val palette = MobilePalette
    NPanel(onClick = select, enabled = enabled, modifier = modifier.height(98.dp),
        shape = RoundedCornerShape(18.dp), border = BorderStroke(1.dp, palette.mirror)) {
        Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.SpaceBetween) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, null, Modifier.size(20.dp), tint = palette.brightAccent)
                if (enabled) Icon(Icons.Outlined.ChevronRight, null, Modifier.size(16.dp), tint = Secondary)
            }
            Column {
                Text(label, color = Secondary, fontSize = 11.sp, maxLines = 1)
                Text(value, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable internal fun ReasoningEffortControl(efforts: List<String>, value: String, enabled: Boolean, select: (String) -> Unit) {
    if (efforts.isEmpty()) return
    val palette = MobilePalette
    val index = efforts.indexOf(value)
    val motion = LocalNautiloMotion.current
    val haptics = LocalHapticFeedback.current
    val levels = if (index < 0) 0 else if (efforts.size == 1) 5 else 1 + (index * 4f / efforts.lastIndex).toInt()
    NPanel(shape = RoundedCornerShape(18.dp), border = BorderStroke(1.dp, palette.mirror)) {
      Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            Text("推理强度", Modifier.weight(1f), fontSize = 12.sp, color = Secondary)
            Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.Bottom) {
                repeat(5) { bar ->
                    val color = animateColorAsState(if (bar < levels) palette.brightAccent else palette.divider,
                        if (motion) tween(180, delayMillis = bar * 16) else snap(), label = "effort-bar")
                    val height = animateDpAsState(if (bar < levels) (6 + bar * 3).dp else (4 + bar * 3).dp,
                        if (motion) spring(dampingRatio = .72f, stiffness = Spring.StiffnessMedium) else snap(), label = "effort-bar-height")
                    Box(Modifier.width(3.dp).height(18.dp), contentAlignment = Alignment.BottomCenter) {
                        Box(Modifier.fillMaxWidth().height(height.value).background(color.value, CircleShape))
                    }
                }
            }
            if (index >= 0) Text(effortName(value), Modifier.clearAndSetSemantics {},
                color = palette.brightAccent, fontSize = 11.sp, fontWeight = FontWeight.Medium)
        }
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val segment = maxOf(44.dp, (maxWidth - 6.dp) / efforts.size)
            val position = animateDpAsState(segment * index.coerceAtLeast(0),
                if (motion) spring(dampingRatio = .72f, stiffness = Spring.StiffnessMedium) else snap(), label = "reasoning-effort")
            val shape = RoundedCornerShape(9.dp)
            Box(Modifier.horizontalScroll(rememberScrollState()).width(segment * efforts.size + 6.dp)
                .height(42.dp).background(if (palette.dark) palette.inset else palette.card, shape).border(1.dp, Line, shape).padding(3.dp)) {
                if (index >= 0) Box(Modifier.width(segment).fillMaxHeight()
                    .graphicsLayer { translationX = position.value.toPx() }
                    .background(palette.primary, RoundedCornerShape(7.dp)))
                Row(Modifier.fillMaxSize().selectableGroup()) {
                    efforts.forEach { item ->
                        Box(Modifier.width(segment).fillMaxHeight().selectable(
                            selected = item == value, enabled = enabled, role = Role.RadioButton, onClick = {
                                haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                select(item)
                            }),
                            contentAlignment = Alignment.Center) {
                            Text(effortName(item), Modifier.padding(horizontal = 4.dp), fontSize = 12.sp,
                                color = if (item == value) palette.onPrimary else Ink, fontWeight = FontWeight.Medium,
                                maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
      }
    }
}
