package app.nautilo.mobile.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
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
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.data.*

internal fun teamSelectionName(id: String, state: MobileState): String = if (id.isEmpty()) "独立工作"
    else state.setup.objects("teams").find { it.text("id") == id }?.text("name")
        ?: state.session?.takeIf { it.teamId == id }?.teamName?.takeIf(String::isNotBlank) ?: "团队不可用"

@Composable internal fun TeamChoiceContent(state: MobileState, selected: String, refresh: () -> Unit, close: () -> Unit, choose: (String) -> Unit) {
    val teams = state.setup.objects("teams").map(MobileTeam::decode)
    var query by remember { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().heightIn(max = 560.dp).padding(horizontal = 20.dp).padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("协作团队", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            ActionIcon(Icons.Outlined.Refresh, "刷新团队", !state.setupLoading, refresh)
            ActionIcon(Icons.Outlined.Close, "关闭团队选择", click = close)
        }
        if (state.setupLoading) NProgress(Modifier.fillMaxWidth())
        if (teams.size > 6) NField(query, { query = it }, singleLine = true, placeholder = { Text("搜索团队") },
            leadingIcon = { Icon(Icons.Outlined.Search, null, Modifier.size(19.dp)) }, modifier = Modifier.fillMaxWidth())
        LazyColumn(Modifier.weight(1f, fill = false).testTag("team-choice-list"), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            item("solo") { TeamChoiceRow("独立工作", null, selected.isEmpty(), true, { choose("") }) }
            items(teams.filter { it.name.contains(query, true) }, key = { it.id }) { team ->
                TeamChoiceRow(team.name, if (team.members.isEmpty()) "没有已启用的成员" else "${team.members.size} 位成员 · " + when (team.policy) {
                    "autonomous" -> "自主委派"; "ask_before_delegate" -> "委派前确认"; "direct_only" -> "仅主 Agent"; else -> "团队协作"
                }, selected == team.id, team.members.isNotEmpty(), { choose(team.id) })
            }
            if (teams.isEmpty() && !state.setupLoading) item {
                Text(if (state.setup.has("teams")) "在电脑端的团队管理中添加团队" else "更新电脑端后可使用团队", color = ComposerSecondary,
                    fontSize = 13.sp, lineHeight = 21.sp, modifier = Modifier.padding(horizontal = 12.dp, vertical = 14.dp))
            }
        }
        NTextButton(close, modifier = Modifier.align(Alignment.End)) { Text("取消") }
    }
}

@Composable private fun TeamChoiceRow(name: String, meta: String?, selected: Boolean, enabled: Boolean, choose: () -> Unit) {
    NPanel(onClick = choose, enabled = enabled, color = if (selected) Selection else Color.Transparent, shape = RoundedCornerShape(16.dp)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 60.dp).padding(horizontal = 13.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(13.dp)) {
            Icon(if (meta == null) Icons.Outlined.PersonOutline else Icons.Outlined.Groups, null, Modifier.size(22.dp), tint = Ink)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(name, fontSize = 15.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium, color = Ink)
                meta?.let { Text(it, fontSize = 12.sp, lineHeight = 19.sp, color = ComposerSecondary) }
            }
            SelectionCheck(selected)
        }
    }
}
