package app.nautilo.mobile.ui

import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material3.Icon
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

internal val MotionEase = CubicBezierEasing(.2f, .8f, .2f, 1f)
internal val LocalNautiloMotion = staticCompositionLocalOf { true }

/** One observer per theme, rather than one Android settings read per control. */
@Composable internal fun ProvideNautiloMotion(content: @Composable () -> Unit) {
    val resolver = LocalContext.current.contentResolver
    fun enabled() = runCatching { Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f }.getOrDefault(true)
    var motion by remember(resolver) { mutableStateOf(enabled()) }
    DisposableEffect(resolver) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) { motion = enabled() }
        }
        resolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, observer)
        onDispose { resolver.unregisterContentObserver(observer) }
    }
    CompositionLocalProvider(LocalNautiloMotion provides motion, content = content)
}

@Composable internal fun rememberEntranceProgress(key: Any?, animate: Boolean = true): Animatable<Float, androidx.compose.animation.core.AnimationVector1D> {
    val motion = LocalNautiloMotion.current
    val progress = remember(key) { Animatable(if (motion && animate) 0f else 1f) }
    LaunchedEffect(key, motion) {
        if (!motion) progress.snapTo(1f)
        else if (progress.value < 1f) progress.animateTo(1f, tween(200, easing = MotionEase))
    }
    return progress
}

/** Only the current page exists. There are no outgoing controls to intercept taps. */
@Composable internal fun MotionPage(key: Any?, content: @Composable () -> Unit) {
    val progress = rememberEntranceProgress(key)
    Box(Modifier.graphicsLayer {
        translationY = (1f - progress.value) * 6.dp.toPx()
    }, propagateMinConstraints = true) { content() }
}

/** Small, one-time arrivals; streamed text updates keep their existing view. */
@Composable internal fun MotionArrival(key: Any?, animate: Boolean, distance: Dp = 5.dp, content: @Composable () -> Unit) {
    val progress = rememberEntranceProgress(key, animate)
    Box(Modifier.graphicsLayer {
        alpha = .65f + .35f * progress.value
        translationY = (1f - progress.value) * distance.toPx()
    }, propagateMinConstraints = true) { content() }
}

/** The button's hit area is fixed; only its symbol changes scale. */
@Composable internal fun MotionSymbol(key: Any?, content: @Composable () -> Unit) {
    val progress = rememberEntranceProgress(key)
    Box(Modifier.graphicsLayer {
        alpha = .65f + .35f * progress.value
        scaleX = .82f + .18f * progress.value
        scaleY = scaleX
    }, contentAlignment = Alignment.Center) { content() }
}

@Composable internal fun SelectionCheck(selected: Boolean) {
    val motion = LocalNautiloMotion.current
    val progress by animateFloatAsState(if (selected) 1f else 0f,
        if (motion) spring(dampingRatio = .72f, stiffness = 700f) else snap(), label = "selection-check")
    Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
        Icon(Icons.Outlined.Check, null, Modifier.size(18.dp).graphicsLayer {
            alpha = progress.coerceIn(0f, 1f)
            scaleX = .65f + .35f * progress
            scaleY = scaleX
            transformOrigin = TransformOrigin.Center
        }, tint = Ink)
    }
}
