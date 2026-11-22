@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package app.nautilo.mobile.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.data.*
import org.json.JSONObject

internal fun JSONObject.localized(key: String): String = optJSONObject(key)?.let { it.text("zh-CN", it.text("en-US")) } ?: text(key)

/** Options are supplied by the current provider/plugin, exactly as on desktop. */
@Composable internal fun ModeConfigurationSheet(catalog: JSONObject, loading: Boolean, permission: String, mode: String,
    locked: Boolean, saving: Boolean, error: String, refresh: () -> Unit, close: () -> Unit, apply: (String, String) -> Unit) {
    var selectedPermission by remember { mutableStateOf(permission) }
    var selectedMode by remember { mutableStateOf(mode) }
    LaunchedEffect(catalog) {
        if (selectedPermission.isEmpty()) selectedPermission = catalog.text("permissionMode", "default")
        if (selectedMode.isEmpty()) selectedMode = catalog.text("defaultMode")
    }
    NSheet(onDismissRequest = { if (!saving) close() }) {
        Column(Modifier.fillMaxWidth().heightIn(max = 640.dp).padding(horizontal = 20.dp).padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("权限与运行模式", Modifier.weight(1f), fontSize = 20.sp, fontWeight = FontWeight.Medium)
                ActionIcon(Icons.Outlined.Refresh, "刷新模式", !loading && !saving, refresh)
                ActionIcon(Icons.Outlined.Close, "关闭", !saving, close)
            }
            if (loading) NProgress()
            Column(Modifier.weight(1f, false).verticalScroll(rememberScrollState()).testTag("mode-config-options"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (catalog.objects("permissionModes").isNotEmpty()) {
                    Text("操作权限", Modifier.padding(vertical = 8.dp), fontSize = 13.sp, color = Secondary)
                    catalog.objects("permissionModes").forEach { item ->
                        ModeRow(item.localized("name").ifEmpty { item.text("value") }, item.localized("description"), item.text("value") == selectedPermission, !saving) { selectedPermission = item.text("value") }
                    }
                }
                if (catalog.optBoolean("modeDiscovery")) {
                    Text("Harness 模式", Modifier.padding(top = 18.dp, bottom = 8.dp), fontSize = 13.sp, color = Secondary)
                    if (locked) Text("模式随原生会话保持，切换模式请新建会话。", Modifier.padding(bottom = 8.dp), fontSize = 13.sp, lineHeight = 21.sp, color = Secondary)
                    if (catalog.text("modeError").isNotEmpty()) Text("原生模式读取失败，请刷新重试。", fontSize = 13.sp, color = Danger)
                    catalog.objects("modes").forEach { item ->
                        ModeRow(item.text("name", item.text("id")), item.text("broken", item.text("description")), item.text("id") == selectedMode,
                            !saving && !locked && item.text("broken").isEmpty()) { selectedMode = item.text("id") }
                    }
                }
                if (!loading && catalog.length() == 0) Text("模式暂未读取，请刷新或更新电脑端。", Modifier.padding(vertical = 16.dp), fontSize = 14.sp, color = Secondary)
                if (error.isNotBlank()) Text(error, fontSize = 13.sp, lineHeight = 21.sp, color = Danger)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                NTextButton(close, enabled = !saving, modifier = Modifier.testTag("mode-config-cancel")) { Text("取消") }
                NButton({ apply(selectedPermission, selectedMode) }, enabled = !loading && !saving && catalog.length() > 0, modifier = Modifier.testTag("mode-config-apply")) { Text(if (saving) "正在保存…" else "完成") }
            }
        }
    }
}

@Composable private fun ModeRow(title: String, detail: String, selected: Boolean, enabled: Boolean, choose: () -> Unit) {
    NPanel(choose, enabled = enabled, color = if (selected) Selection else MobilePalette.card) {
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(title, fontSize = 16.sp, lineHeight = 24.sp, color = if (enabled || selected) Ink else Secondary)
                if (detail.isNotBlank()) Text(detail, fontSize = 13.sp, lineHeight = 21.sp, color = Secondary)
            }
            SelectionCheck(selected)
        }
    }
}
