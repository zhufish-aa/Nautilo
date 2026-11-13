@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package app.nautilo.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.MobileViewModel
import app.nautilo.mobile.data.*

@Composable fun NewProjectSheet(state: MobileState, model: MobileViewModel, close: () -> Unit, created: (Project) -> Unit) {
    var path by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var newFolder by rememberSaveable { mutableStateOf(false) }
    var folderName by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(Unit) { model.browse() }
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Color(0xFFFCFDFE)) {
        Column(Modifier.heightIn(max = 700.dp).verticalScroll(rememberScrollState()).padding(horizontal = 22.dp).padding(bottom = 24.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("新建项目", style = MaterialTheme.typography.titleLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = !newFolder, onClick = { newFolder = false }, label = { Text("已有目录") })
                FilterChip(selected = newFolder, onClick = { newFolder = true }, label = { Text("新建文件夹") })
            }
            OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("项目名称") }, singleLine = true, shape = RoundedCornerShape(13.dp), modifier = Modifier.fillMaxWidth())
            if (newFolder) OutlinedTextField(value = folderName, onValueChange = { folderName = it }, label = { Text("文件夹名称") }, singleLine = true, shape = RoundedCornerShape(13.dp), modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = path, onValueChange = { path = it }, label = { Text(if (newFolder) "创建到电脑上的目录" else "电脑上的工作目录") }, shape = RoundedCornerShape(13.dp), modifier = Modifier.fillMaxWidth(),
                trailingIcon = { ActionIcon(Icons.Outlined.ArrowForward, "打开目录", !state.directoryLoading) { model.browse(path) } })
            if (state.directoryLoading) LinearProgressIndicator(Modifier.fillMaxWidth())
            Surface(shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, Line)) {
                LazyColumn(Modifier.heightIn(min = 120.dp, max = 260.dp)) {
                    if (state.directory.text("path").isNotEmpty()) item("parent") {
                        Row(Modifier.fillMaxWidth().clickable { path = state.directory.text("parent"); model.browse(path) }.padding(13.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.DriveFolderUpload, null, Modifier.size(20.dp), tint = Blue)
                            Text("上一级", Modifier.padding(start = 12.dp), fontSize = 13.sp)
                        }
                    }
                    items(state.directory.objects("directories"), key = { it.text("path") }) { folder ->
                        Row(Modifier.fillMaxWidth().clickable { path = folder.text("path"); model.browse(path) }.padding(13.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.FolderOpen, null, Modifier.size(20.dp), tint = Blue)
                            Text(folder.text("name"), Modifier.weight(1f).padding(horizontal = 12.dp), fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Icon(Icons.Outlined.ChevronRight, null, Modifier.size(16.dp), tint = Secondary)
                        }
                    }
                    if (!state.directory.isNull("nextOffset")) item("more") { TextButton(onClick = { model.browse(state.directory.text("path"), state.directory.optInt("nextOffset")) }) { Text("加载更多目录") } }
                }
            }
            if (state.error.isNotBlank()) Text(state.error, color = Danger, fontSize = 13.sp)
            Button(enabled = path.isNotBlank() && (!newFolder || folderName.isNotBlank()) && state.connected && !state.changing,
                onClick = { model.createProject(name, path, if (newFolder) folderName else "", created) }, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(14.dp)) {
                if (state.changing) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = Color.White) else Text(if (newFolder) "创建项目" else "添加为项目", color = Color.White)
            }
        }
    }
}
