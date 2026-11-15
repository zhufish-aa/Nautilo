package app.nautilo.mobile.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.webkit.WebView
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.MobileViewModel
import app.nautilo.mobile.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction

@Composable fun FilePreviewScreen(state: MobileState, model: MobileViewModel) {
    val file = state.filePreview
    val clipboard = LocalClipboardManager.current
    var wrap by remember { mutableStateOf(false) }
    var source by remember(file.path) { mutableStateOf(false) }
    val text by produceState<String?>(null, file.bytes) {
        value = withContext(Dispatchers.Default) { previewText(file.bytes) }
    }
    val markdown = file.path.substringAfterLast('.').lowercase() in listOf("md", "markdown")
    Column(Modifier.fillMaxSize().background(Color.White)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).padding(start = 6.dp)) {
                Text(file.path.replace('\\', '/').substringBeforeLast('/', "文件预览"), fontSize = 11.sp, color = Secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(fileSize(file.size) + (file.line?.let { " · 第 ${it} 行" } ?: ""), fontSize = 11.sp, color = Secondary)
            }
            if (markdown) NTextButton({ source = !source }) { Text(if (source) "预览" else "源码", fontSize = 13.sp) }
            if (text != null && !file.isBinaryPreview()) {
                ActionIcon(Icons.Outlined.WrapText, if (wrap) "取消换行" else "自动换行") { wrap = !wrap }
                ActionIcon(Icons.Outlined.ContentCopy, "复制内容") { clipboard.setText(AnnotatedString(text.orEmpty())) }
            }
            ActionIcon(Icons.Outlined.Refresh, "刷新文件", !file.loading) { model.previewFile(FileReference(file.path, file.line)) }
        }
        if (file.loading) NProgress(Modifier.fillMaxWidth())
        if (file.error.isNotBlank()) {
            Column(Modifier.fillMaxWidth().heightIn(max = 360.dp).verticalScroll(rememberScrollState()).padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(file.error, color = Danger, fontSize = 14.sp, lineHeight = 22.sp)
                file.candidates.forEach { path -> NTextButton({ model.previewFile(FileReference(path, file.line)) }) { Text(path, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) } }
                NTextButton({ state.fileProject?.let { model.openProjectFiles(it.id) } }) { Icon(Icons.Outlined.FolderOpen, null, Modifier.size(17.dp)); Text(" 浏览项目文件") }
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                file.bytes.isEmpty() && file.error.isNotBlank() -> Unit
                file.bytes.isEmpty() && file.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { NSpinner(Modifier.size(24.dp)) }
                file.mimeType == "image/svg+xml" -> SvgPreview(file.bytes)
                file.mimeType.startsWith("image/") -> ImageFilePreview(file.bytes)
                file.mimeType == "application/pdf" -> PdfFilePreview(file.bytes)
                text != null && markdown && !source -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(18.dp)) { item { Markdown(text.orEmpty()) } }
                text != null -> CodeFilePreview(text.orEmpty(), file.path, file.line, wrap)
                file.bytes.isNotEmpty() -> EmptyView(Icons.Outlined.InsertDriveFile, "此格式暂不支持内嵌预览")
            }
        }
        file.nextOffset?.takeIf { text != null }?.let {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("已读取 ${fileSize(file.bytes.size.toLong())} / ${fileSize(file.size)}", Modifier.weight(1f), fontSize = 12.sp, color = Secondary)
                NTextButton({ model.previewFile(FileReference(file.path, file.line), more = true) }, enabled = !file.loading) { Text("继续读取") }
            }
        }
    }
}

internal fun previewText(bytes: ByteArray): String? {
    if (bytes.take(8192).any { it == 0.toByte() }) return null
    return runCatching {
        val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
        val chars = CharBuffer.allocate(bytes.size)
        val result = decoder.decode(ByteBuffer.wrap(bytes), chars, false)
        if (result.isError) return null
        chars.flip(); chars.toString().removePrefix("\uFEFF")
    }.getOrNull()
}

@Composable private fun CodeFilePreview(text: String, path: String, line: Int?, wrap: Boolean) {
    val rows = remember(text) { previewCodeRows(text) }
    val list = rememberLazyListState()
    val result by produceState<Pair<String, AnnotatedString>?>(null, text, path) {
        value = if (text.length <= 200_000) withContext(Dispatchers.Default) { text to highlightCode(text, path) } else null
    }
    val highlighted = result?.takeIf { it.first === text }?.second
    LaunchedEffect(path, line) { if (line != null) list.scrollToItem(rows.indexOfFirst { it.line == line }.coerceAtLeast(0)) }
    val horizontal = rememberScrollState()
    BoxWithConstraints(Modifier.fillMaxSize()) {
      val fontScale = LocalDensity.current.fontScale
      val gutter = (maxOf(4, rows.lastOrNull()?.line.toString().length) * 8 * fontScale + 14).dp
      val columns: Int = remember(rows) { rows.maxOfOrNull { row -> row.text.fold(0) { width, char -> width + if (char.code > 255) 2 else 1 } } ?: 0 }
      val codeWidth = (columns * 9 * fontScale + 12).dp.coerceAtLeast((maxWidth - gutter).coerceAtLeast(1.dp))
      SelectionContainer {
        LazyColumn(Modifier.fillMaxSize().testTag("file-preview-code"), state = list, contentPadding = PaddingValues(vertical = 10.dp)) {
            itemsIndexed(rows) { _, row ->
                val content = row.text
                val colored by produceState(AnnotatedString(content), highlighted, content, path) {
                    value = highlighted?.subSequence(row.offset, row.offset + content.length)
                        ?: if (text.length > 200_000) withContext(Dispatchers.Default) { highlightCode(content, path) } else AnnotatedString(content)
                }
                Row(Modifier.fillMaxWidth().background(if (line == row.line) Selection else Color.Transparent).padding(end = 12.dp).padding(vertical = 1.dp), verticalAlignment = Alignment.Top) {
                    Text(if (row.continuation) "↳" else "${row.line}", Modifier.width(gutter).padding(end = 12.dp), color = if (line == row.line) Ink else Secondary, fontFamily = CodeFont, fontSize = 12.sp, lineHeight = 22.sp, textAlign = androidx.compose.ui.text.style.TextAlign.End)
                    if (wrap) Text(colored, Modifier.weight(1f), color = Ink, fontFamily = CodeFont, fontSize = 14.sp, lineHeight = 22.sp)
                    else Box(Modifier.weight(1f).horizontalScroll(horizontal)) {
                        Text(colored, Modifier.width(codeWidth), color = Ink, fontFamily = CodeFont, fontSize = 14.sp, lineHeight = 22.sp, softWrap = false)
                    }
                }
            }
        }
      }
    }
}

internal data class PreviewCodeRow(val text: String, val line: Int, val offset: Int, val continuation: Boolean)
internal fun previewCodeRows(text: String): List<PreviewCodeRow> {
    var offset = 0
    return buildList {
        text.splitToSequence('\n').forEachIndexed { index, value ->
            val content = value.removeSuffix("\r")
            if (content.isEmpty()) add(PreviewCodeRow("", index + 1, offset, false))
            else {
                var start = 0
                while (start < content.length) {
                    var end = minOf(start + 1_024, content.length)
                    if (end < content.length && content[end - 1].isHighSurrogate() && content[end].isLowSurrogate()) end--
                    add(PreviewCodeRow(content.substring(start, end), index + 1, offset + start, start > 0)); start = end
                }
            }
            offset += value.length + 1
        }
    }
}

@Composable private fun ImageFilePreview(bytes: ByteArray) {
    var decoded by remember(bytes) { mutableStateOf(false) }
    val bitmap by produceState<Bitmap?>(null, bytes) { value = withContext(Dispatchers.Default) {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) null else {
            var sample = 1
            while (bounds.outWidth / sample > 2048 || bounds.outHeight / sample > 2048) sample *= 2
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
        }
    }; decoded = true }
    val current = bitmap
    if (current != null) ZoomablePreviewImage(current)
    else EmptyView(Icons.Outlined.Image, if (decoded) "无法读取此图片" else "正在读取图片")
}

@Composable internal fun ZoomablePreviewImage(current: Bitmap) {
        var scale by remember(current) { mutableFloatStateOf(1f) }
        var offset by remember(current) { mutableStateOf(Offset.Zero) }
        Box(Modifier.fillMaxSize().clipToBounds()
            .pointerInput(current) { detectTransformGestures { _, pan, zoom, _ ->
                scale = (scale * zoom).coerceIn(1f, 6f)
                val limitX = size.width * (scale - 1f) / 2f; val limitY = size.height * (scale - 1f) / 2f
                offset = Offset((offset.x + pan.x).coerceIn(-limitX, limitX), (offset.y + pan.y).coerceIn(-limitY, limitY))
            } }
            .pointerInput(current) { detectTapGestures(onDoubleTap = { scale = if (scale > 1f) 1f else 2f; offset = Offset.Zero }) }) {
            Image(current.asImageBitmap(), "图片预览，可双指缩放", Modifier.fillMaxSize().padding(12.dp).graphicsLayer {
                scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y
            })
        }
}

@Composable private fun SvgPreview(bytes: ByteArray) {
    val source = remember(bytes) { String(bytes, Charsets.UTF_8) }
    AndroidView(factory = { context -> WebView(context).apply {
        settings.javaScriptEnabled = false; settings.allowFileAccess = false; settings.allowContentAccess = false
        settings.blockNetworkLoads = true; settings.builtInZoomControls = true; settings.displayZoomControls = false
    } }, update = { if (it.tag != source) { it.tag = source; it.loadDataWithBaseURL(null, source, "image/svg+xml", "UTF-8", null) } },
        onRelease = { it.destroy() }, modifier = Modifier.fillMaxSize())
}

private class PdfDocument(context: android.content.Context, bytes: ByteArray) : AutoCloseable {
    private val file = File.createTempFile("nautilo-preview-", ".pdf", context.cacheDir)
    private val renderer: PdfRenderer
    private var closed = false
    val count: Int
    private val targetWidth = context.resources.displayMetrics.widthPixels.coerceIn(720, 1800)
    init {
        try {
            file.writeBytes(bytes)
            val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
            try { renderer = PdfRenderer(descriptor); count = renderer.pageCount } catch (error: Exception) { descriptor.close(); throw error }
        } catch (error: Exception) { file.delete(); throw error }
    }
    @Synchronized fun page(index: Int): Bitmap? {
        if (closed) return null
        return renderer.openPage(index).use { page ->
            val scale = minOf(targetWidth.toFloat() / page.width.coerceAtLeast(1), 3200f / page.height.coerceAtLeast(1))
            val bitmap = Bitmap.createBitmap((page.width * scale).toInt().coerceAtLeast(1), (page.height * scale).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(android.graphics.Color.WHITE)
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY); bitmap
        }
    }
    @Synchronized override fun close() { if (!closed) { closed = true; renderer.close(); file.delete() } }
}

@Composable private fun PdfFilePreview(bytes: ByteArray) {
    val context = LocalContext.current
    val loaded by produceState<Pair<Boolean, PdfDocument?>>(false to null, bytes) {
        var opened: PdfDocument? = null
        try {
            value = false to null
            withContext(Dispatchers.IO) { opened = runCatching { PdfDocument(context, bytes) }.getOrNull() }
            value = true to opened
            kotlinx.coroutines.awaitCancellation()
        } finally { opened?.close() }
    }
    val document = loaded.second
    if (document == null) { EmptyView(Icons.Outlined.PictureAsPdf, if (loaded.first) "无法读取此 PDF" else "正在读取 PDF"); return }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        items(document.count) { index ->
            val bitmap by produceState<Bitmap?>(null, document, index) { value = withContext(Dispatchers.Default) { document.page(index) } }
            Column(Modifier.fillMaxWidth()) {
                bitmap?.let { Image(it.asImageBitmap(), "第 ${index + 1} 页", Modifier.fillMaxWidth().aspectRatio(it.width.toFloat() / it.height)) }
                Text("${index + 1} / ${document.count}", Modifier.align(Alignment.CenterHorizontally).padding(top = 4.dp), fontSize = 11.sp, color = Secondary)
            }
        }
    }
}
