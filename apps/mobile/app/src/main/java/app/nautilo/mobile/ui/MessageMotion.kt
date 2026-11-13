package app.nautilo.mobile.ui

import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp

private val ArrivalEase = CubicBezierEasing(.23f, 1f, .32f, 1f)

/** Only newly sent bubbles enter. Receipts and history hydration keep their position. */
@Composable fun MessageArrival(id: String, newlySent: Boolean, content: @Composable () -> Unit) {
    val context = LocalContext.current
    val reduce = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    val progress = remember(id) { Animatable(if (newlySent && !reduce) 0f else 1f) }
    LaunchedEffect(id) { if (progress.value < 1f) progress.animateTo(1f, tween(240, easing = ArrivalEase)) }
    Box(Modifier.graphicsLayer {
        transformOrigin = TransformOrigin(.95f, 1f)
        alpha = progress.value
        scaleX = .97f + .03f * progress.value
        scaleY = scaleX
        translationY = (1f - progress.value) * 16.dp.toPx()
    }) { content() }
}

@Composable fun SendAction(enabled: Boolean, send: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) .97f else 1f, tween(160, easing = ArrivalEase), label = "send-press")
    FilledIconButton(onClick = send, enabled = enabled, interactionSource = interaction,
        modifier = Modifier.size(39.dp).graphicsLayer { scaleX = scale; scaleY = scale },
        colors = IconButtonDefaults.filledIconButtonColors(containerColor = Selection, contentColor = Ink, disabledContainerColor = Color(0xFFF2F5F8))) {
        Icon(Icons.Outlined.ArrowUpward, "发送消息", Modifier.size(22.dp))
    }
}
