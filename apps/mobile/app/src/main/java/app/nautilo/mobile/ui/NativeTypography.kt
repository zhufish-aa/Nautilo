package app.nautilo.mobile.ui

import android.content.Context
import android.graphics.Typeface
import android.os.Build
import android.widget.TextView
import app.nautilo.mobile.R

internal fun readingTypeface(context: Context, weight: Int = 400): Typeface {
    val family = context.resources.getFont(R.font.nautilo_text)
    return if (Build.VERSION.SDK_INT >= 28) Typeface.create(family, weight, false)
    else Typeface.create(family, if (weight >= 600) Typeface.BOLD else Typeface.NORMAL)
}

internal fun TextView.readingStyle(size: Float = 17f, line: Float = 28f, weight: Int = 400) {
    textSize = size
    typeface = readingTypeface(context, weight)
    includeFontPadding = false
    val desired = (line * resources.displayMetrics.scaledDensity).toInt()
    if (Build.VERSION.SDK_INT >= 28) setLineHeight(desired)
    else setLineSpacing(desired - (paint.fontMetricsInt.descent - paint.fontMetricsInt.ascent).toFloat(), 1f)
    letterSpacing = 0f
}
