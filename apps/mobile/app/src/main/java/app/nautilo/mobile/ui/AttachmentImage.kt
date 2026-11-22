package app.nautilo.mobile.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.nautilo.mobile.data.ChatAttachment
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

internal typealias AttachmentImageLoader = suspend (ChatAttachment, String) -> File
internal val LocalAttachmentImageLoader = staticCompositionLocalOf<AttachmentImageLoader> {
    { attachment, _ -> File(attachment.localPath).also { require(it.isFile) { "图片暂不可用" } } }
}

/** The same thumbnail is used in the draft and the durable message, with an in-app lightbox. */
@Composable internal fun AttachmentImage(attachment: ChatAttachment, sessionId: String = "", compact: Boolean = false, modifier: Modifier = Modifier) {
    val loader = LocalAttachmentImageLoader.current
    var attempt by remember(attachment.id) { mutableIntStateOf(0) }
    var expanded by remember(attachment.id) { mutableStateOf(false) }
    var file by remember(attachment, loader) { mutableStateOf<File?>(null) }
    var error by remember(attachment, loader) { mutableStateOf("") }
    var loading by remember(attachment, loader) { mutableStateOf(true) }
    val bitmap by produceState<Bitmap?>(null, attachment, sessionId, loader, attempt) {
        loading = true; error = ""
        try {
            file = loader(attachment, sessionId)
            value = withContext(Dispatchers.IO) { decodeAttachmentImage(requireNotNull(file), if (compact) 256 else 720) }
            if (value == null) error = "此图片格式暂不可预览"
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { error = "图片加载失败，点按重试" }
        finally { loading = false }
    }
    val current = bitmap
    val frame = if (compact) Modifier.size(84.dp) else Modifier.widthIn(max = 280.dp).fillMaxWidth().heightIn(min = 100.dp, max = 260.dp)
    Box(modifier.then(frame).clip(RoundedCornerShape(if (compact) 14.dp else 16.dp)).background(Selection)
        .testTag("attachment-image-${attachment.id}")
        .clickable { if (current != null) expanded = true else if (!loading) attempt++ }, contentAlignment = Alignment.Center) {
        if (current != null) Image(current.asImageBitmap(), attachment.name,
            Modifier.then(if (compact) Modifier.fillMaxSize() else Modifier.fillMaxWidth().heightIn(max = 260.dp)),
            contentScale = if (compact) ContentScale.Crop else ContentScale.Fit)
        else if (loading) NSpinner(Modifier.padding(24.dp).size(20.dp), strokeWidth = 1.5.dp)
        else Column(Modifier.padding(12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(Icons.Outlined.BrokenImage, null, Modifier.size(22.dp), tint = Secondary)
            if (!compact) Text(error, fontSize = 12.sp, color = Secondary)
        }
    }
    if (expanded && file != null) AttachmentImageViewer(requireNotNull(file), attachment.name) { expanded = false }
}

@Composable private fun AttachmentImageViewer(file: File, name: String, close: () -> Unit) {
    val bitmap by produceState<Bitmap?>(null, file) { value = withContext(Dispatchers.IO) { decodeAttachmentImage(file, 2048) } }
    Dialog(close, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Column(Modifier.fillMaxSize().background(MobilePalette.canvas).statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                ActionIcon(Icons.Outlined.Close, "关闭图片", click = close)
                Text(name, Modifier.weight(1f).padding(horizontal = 8.dp), maxLines = 1, fontSize = 15.sp)
            }
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                bitmap?.let { ZoomablePreviewImage(it) } ?: NSpinner(Modifier.size(24.dp))
            }
        }
    }
}

internal fun decodeAttachmentImage(file: File, maxSide: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (bounds.outWidth / sample > maxSide || bounds.outHeight / sample > maxSide) sample *= 2
    val original = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
    val orientation = runCatching { ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }.getOrDefault(1)
    val matrix = Matrix().apply { when (orientation) {
        2 -> setScale(-1f, 1f); 3 -> setRotate(180f); 4 -> setScale(1f, -1f)
        5 -> { setRotate(90f); postScale(-1f, 1f) }; 6 -> setRotate(90f)
        7 -> { setRotate(-90f); postScale(-1f, 1f) }; 8 -> setRotate(-90f)
    } }
    return if (matrix.isIdentity) original else Bitmap.createBitmap(original, 0, 0, original.width, original.height, matrix, true)
}
