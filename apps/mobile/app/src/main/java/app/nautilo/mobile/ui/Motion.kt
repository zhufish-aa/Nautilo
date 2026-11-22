package app.nautilo.mobile.ui

import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.CircleShape
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

internal val MotionEase = CubicBezierEasing(.22f, 1f, .36f, 1f)
internal val LocalNautiloMotion = staticCompositionLocalOf { true }

@Composable internal fun Modifier.springPress(pressed: Boolean): Modifier {
    val scale = animateFloatAsState(if (pressed) .965f else 1f,
        if (LocalNautiloMotion.current) spring(Spring.DampingRatioMediumBouncy, Spring.StiffnessMedium) else snap(),
        label = "press-scale")
    return graphicsLayer { scaleX = scale.value; scaleY = scale.value }
}

/** One observer per theme, rather than one Android settings read per control. */
@Composable internal fun ProvideNautiloMotion(content: @Composable () -> Unit) {
    val parentAllowsMotion = LocalNautiloMotion.current
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
    CompositionLocalProvider(LocalNautiloMotion provides (parentAllowsMotion && motion), content = content)
}

@Composable internal fun rememberEntranceProgress(key: Any?, animate: Boolean = true, delayMs: Int = 0): Animatable<Float, androidx.compose.animation.core.AnimationVector1D> {
    val motion = LocalNautiloMotion.current
    val progress = remember(key) { Animatable(if (motion && animate) 0f else 1f) }
    LaunchedEffect(key, motion) {
        if (!motion) progress.snapTo(1f)
        else if (progress.value < 1f) progress.animateTo(1f, tween(200, delayMillis = delayMs, easing = MotionEase))
    }
    return progress
}

@Composable internal fun MotionPage(page: CreationPicker?, content: @Composable (CreationPicker?) -> Unit) {
    val motion = LocalNautiloMotion.current
    AnimatedContent(targetState = page, modifier = Modifier.fillMaxWidth().height(500.dp), transitionSpec = {
        val direction = if (targetState == null) -1 else 1
        if (motion) {
            (slideInHorizontally(tween(240, easing = MotionEase)) { it * direction } + fadeIn(tween(180)))
                .togetherWith(slideOutHorizontally(tween(220, easing = MotionEase)) { -it * direction } + fadeOut(tween(160)))
        } else fadeIn(tween(0)).togetherWith(fadeOut(tween(0)))
    }, label = "configuration-page") { current -> content(current) }
}

/** Small, one-time arrivals; streamed text updates keep their existing view. */
@Composable internal fun MotionArrival(key: Any?, animate: Boolean, distance: Dp = 5.dp, delayMs: Int = 0, content: @Composable () -> Unit) {
    val progress = rememberEntranceProgress(key, animate, delayMs)
    Box(Modifier.graphicsLayer {
        alpha = progress.value
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
        }, tint = Accent)
    }
}

@Composable internal fun SonarPulseDot(online: Boolean, modifier: Modifier = Modifier) {
    val tone = if (online) Green else MobilePalette.muted
    val wave = if (online && LocalNautiloMotion.current) rememberInfiniteTransition(label = "host-signal").animateFloat(
        0f, 1f, infiniteRepeatable(tween(2200, easing = FastOutSlowInEasing)), label = "sonar-ring") else null
    Canvas(modifier.size(18.dp)) {
        val radius = 3.5.dp.toPx()
        wave?.value?.let { progress ->
            drawCircle(tone.copy(alpha = .65f * (1f - progress)), radius * (1f + 1.6f * progress),
                style = androidx.compose.ui.graphics.drawscope.Stroke(1.dp.toPx()))
        }
        drawCircle(tone, radius)
    }
}
