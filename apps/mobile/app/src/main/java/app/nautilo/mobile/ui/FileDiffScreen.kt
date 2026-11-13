package app.nautilo.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.MobileViewModel
import app.nautilo.mobile.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private data class ColoredDiffLine(val line: DiffLine, val text: AnnotatedString)

private fun coloredLines(lines: List<DiffLine>, path: String): List<ColoredDiffLine> {
    val old = lines.filter { it.kind in listOf(DiffKind.Context, DiffKind.Removed) }
    val new = lines.filter { it.kind in listOf(DiffKind.Context, DiffKind.Added) }
    fun side(values: List<DiffLine>): Map<DiffLine, AnnotatedString> {
        val highlighted = highlightCode(values.joinToString("\n") { it.text }, path)
        var offset = 0
        return values.associateWith { row -> highlighted.subSequence(offset, offset + row.text.length).also { offset += row.text.length + 1 } }
    }
    val oldColors = side(old)
    val newColors = side(new)
    return lines.map { ColoredDiffLine(it, newColors[it] ?: oldColors[it] ?: AnnotatedString(it.text)) }
}

@Composable fun FileDiffScreen(state: MobileState, model: MobileViewModel) {
    val source = state.workspace.find { it.text("path") == state.diffPath }
    val decoded by produceState<Pair<org.json.JSONObject, FileChange>?>(null, source) {
        value = source?.let { withContext(Dispatchers.Default) { it to FileChange.decode(it) } }
    }
    if (source == null) { EmptyView(Icons.Outlined.InsertDriveFile, "此文件已不在变更列表中"); return }
    val change = decoded?.takeIf { it.first === source }?.second
    if (change == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
        return
    }
    var mode by remember(state.diffPath) { mutableStateOf("diff") }
    var wrap by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val list = rememberLazyListState()
    val lines = remember(change, mode) {
        if (mode == "file") source.text("after").lines().mapIndexed { i, text -> DiffLine(DiffKind.Context, text, newNumber = i + 1) }
        else change.lines
    }
    val coloredResult by produceState<Pair<List<DiffLine>, List<ColoredDiffLine>>?>(null, lines, state.diffPath) {
        value = withContext(Dispatchers.Default) { lines to coloredLines(lines, state.diffPath) }
    }
    val colored = coloredResult?.takeIf { it.first === lines }?.second
    val hunks = remember(lines) { lines.indices.filter { lines[it].kind == DiffKind.Hunk } }
    val currentHunk by remember(hunks) { derivedStateOf { hunks.indexOfLast { it <= list.firstVisibleItemIndex }.coerceAtLeast(0) } }
    Column(Modifier.fillMaxSize()) {
        Surface(color = Color.White.copy(alpha = .85f), shape = RoundedCornerShape(20.dp), modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
            Column(Modifier.fillMaxWidth().padding(15.dp), verticalArrangement = Arrangement.spacedBy(13.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    FileTypeIcon(change.path, large = true)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(change.name, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                        Text(change.folder, fontSize = 11.sp, color = Secondary, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                    }
                    if (change.verifiedDiff) ChangeCount(change.added, change.removed)
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    CompactChoice("变更", mode == "diff") { mode = "diff" }
                    if (source.has("after") && !source.isNull("after")) CompactChoice("当前文件", mode == "file") { mode = "file" }
                    Spacer(Modifier.weight(1f))
                    Surface(onClick = { wrap = !wrap }, color = if (wrap) Selection else Color.Transparent, shape = RoundedCornerShape(9.dp)) {
                        Icon(Icons.Outlined.WrapText, "自动换行", Modifier.padding(8.dp).size(18.dp), tint = if (wrap) Blue else Secondary)
                    }
                }
            }
        }
        if (colored == null) Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
        else if (lines.isEmpty()) Box(Modifier.weight(1f)) { EmptyView(Icons.Outlined.Difference, if (change.verifiedDiff) "没有内容差异" else "原生 Harness 未提供差异内容") }
        else Surface(color = Color.White, shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp), modifier = Modifier.weight(1f).padding(horizontal = 8.dp)) {
            BoxWithConstraints {
                val codeWidth = if (wrap) maxWidth else maxOf(maxWidth, ((lines.maxOfOrNull { it.text.length } ?: 0) * 8 + 110).coerceAtMost(12000).dp)
                Box(if (wrap) Modifier else Modifier.horizontalScroll(rememberScrollState())) {
                    SelectionContainer {
                        LazyColumn(state = list, modifier = Modifier.width(codeWidth).fillMaxHeight(), contentPadding = PaddingValues(vertical = 12.dp)) {
                            itemsIndexed(colored.orEmpty(), key = { index, _ -> "$mode:$index" }) { _, row -> DiffCodeRow(row, wrap) }
                        }
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
            if (hunks.isNotEmpty()) {
                ActionIcon(Icons.Outlined.ChevronLeft, "上一处改动", currentHunk > 0) { scope.launch { list.animateScrollToItem(hunks[(currentHunk - 1).coerceAtLeast(0)]) } }
                Text("${currentHunk + 1} / ${hunks.size} 处改动", fontSize = 12.sp, color = Secondary)
                ActionIcon(Icons.Outlined.ChevronRight, "下一处改动", currentHunk < hunks.lastIndex) { scope.launch { list.animateScrollToItem(hunks[(currentHunk + 1).coerceAtMost(hunks.lastIndex)]) } }
            } else Text("${lines.size} 行", fontSize = 12.sp, color = Secondary)
            Spacer(Modifier.weight(1f))
            TextButton(onClick = { model.navigate(app.nautilo.mobile.Screen.Workspace) }) { Text("文件列表", fontSize = 12.sp); Icon(Icons.Outlined.FormatListBulleted, null, Modifier.padding(start = 6.dp).size(17.dp)) }
        }
        if (change.truncated) Text("原生变更内容已截断", color = Secondary, fontSize = 11.sp, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
    }
}

@Composable private fun DiffCodeRow(row: ColoredDiffLine, wrap: Boolean) {
    val line = row.line
    val background = when (line.kind) { DiffKind.Added -> Color(0xFFEAF6EE); DiffKind.Removed -> Color(0xFFFCEEEF); DiffKind.Hunk -> Color(0xFFF1F6FA); else -> Color.White }
    Row(Modifier.fillMaxWidth().background(background).padding(vertical = if (line.kind == DiffKind.Hunk) 9.dp else 3.dp), verticalAlignment = Alignment.Top) {
        if (line.kind == DiffKind.Hunk) Text(line.text, Modifier.padding(horizontal = 14.dp), fontFamily = CodeFont, fontSize = 11.sp, lineHeight = 18.sp, color = Secondary)
        else {
            val numberStyle = androidx.compose.ui.text.TextStyle(fontFamily = CodeFont, fontSize = 10.sp, lineHeight = 21.sp, color = Secondary)
            Text(line.oldNumber?.toString().orEmpty(), Modifier.width(35.dp), textAlign = androidx.compose.ui.text.style.TextAlign.End, style = numberStyle)
            Text(line.newNumber?.toString().orEmpty(), Modifier.width(35.dp).padding(end = 5.dp), textAlign = androidx.compose.ui.text.style.TextAlign.End, style = numberStyle)
            Text(when (line.kind) { DiffKind.Added -> "+"; DiffKind.Removed -> "−"; else -> " " }, Modifier.width(16.dp), fontSize = 11.sp, lineHeight = 21.sp, color = if (line.kind == DiffKind.Removed) Danger else Green)
            Text(row.text, Modifier.weight(1f).padding(end = 15.dp), fontFamily = CodeFont, fontSize = 12.sp, lineHeight = 21.sp, color = Ink, softWrap = wrap,
                style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "\"liga\" 0, \"calt\" 0"))
        }
    }
}

@Composable internal fun CompactChoice(text: String, selected: Boolean, click: () -> Unit) {
    Surface(onClick = click, color = if (selected) Ink else Color(0xFFF0F4F7), shape = RoundedCornerShape(10.dp)) {
        Text(text, Modifier.padding(horizontal = 13.dp, vertical = 9.dp), fontSize = 12.sp, fontWeight = FontWeight.Medium, color = if (selected) Color.White else Ink)
    }
}
@Composable internal fun ChangeCount(added: Int, removed: Int) {
    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        if (added > 0) Text("+$added", color = Green, fontSize = 11.sp, fontWeight = FontWeight.Medium)
        if (removed > 0) Text("−$removed", color = Danger, fontSize = 11.sp, fontWeight = FontWeight.Medium)
        if (added == 0 && removed == 0) Text("无差异", color = Secondary, fontSize = 11.sp)
    }
}
