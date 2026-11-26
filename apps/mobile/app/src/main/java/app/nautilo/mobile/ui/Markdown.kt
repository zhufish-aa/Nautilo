package app.nautilo.mobile.ui

import android.content.Context
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.Typeface
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.os.SystemClock
import android.text.Spanned
import android.text.Spannable
import android.text.SpannableString
import android.text.style.ForegroundColorSpan
import android.text.style.URLSpan
import android.text.style.ClickableSpan
import android.text.style.CharacterStyle
import android.text.style.UpdateAppearance
import android.text.TextPaint
import android.text.method.LinkMovementMethod
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.ViewTreeObserver
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TableLayout
import android.widget.TableRow
import android.widget.TextView
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.viewinterop.AndroidView
import io.noties.markwon.AbstractMarkwonPlugin
import io.noties.markwon.Markwon
import io.noties.markwon.core.MarkwonTheme
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.Table
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.node.Document
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.parser.Parser
import app.nautilo.mobile.data.FileReference
import app.nautilo.mobile.data.StreamingMarkdownBoundary
import app.nautilo.mobile.data.fileReference
import app.nautilo.mobile.data.normalizeMarkdownFileLinks

internal val LocalFileOpener = staticCompositionLocalOf<((FileReference) -> Unit)?> { null }

@Composable fun Markdown(text: String, modifier: Modifier = Modifier, fontSize: Float = 17f, lineHeight: Float = 28f,
    color: Color = Ink, streaming: Boolean = false, fade: Boolean = false) {
    val open = LocalFileOpener.current
    val palette = MobilePalette
    androidx.compose.runtime.key(palette) {
        AndroidView(factory = { MarkdownView(it, fontSize, lineHeight, color.toArgb(), palette) },
            modifier = modifier.fillMaxWidth(), update = { it.onFileOpen = open; it.render(text, streaming, fade) })
    }
}

/** Native table cells remain selectable and wide tables scroll independently of the conversation. */
internal class MarkdownView(context: Context, private val bodySize: Float = 17f, private val bodyLineHeight: Float = 28f, private val bodyColor: Int = LightMobileColors.ink.toArgb(), private val colors: MobileColors = LightMobileColors) : LinearLayout(context) {
    var onFileOpen: ((FileReference) -> Unit)? = null
    private val markwon = Markwon.builder(context)
        .usePlugin(StrikethroughPlugin.create())
        .usePlugin(object : AbstractMarkwonPlugin() {
            override fun configureParser(builder: Parser.Builder) {
                // Native cells render their inline children, without TextView's table span visitor.
                builder.extensions(listOf(TablesExtension.create()))
            }
            override fun configureTheme(builder: MarkwonTheme.Builder) {
                builder.linkColor(colors.ink.toArgb()).isLinkUnderlined(true)
                    .codeBackgroundColor(colors.inset.toArgb()).codeTextColor(colors.ink.toArgb())
                    .codeTypeface(readingTypeface(context))
                    .codeTextSize((15 * resources.displayMetrics.scaledDensity).toInt())
                    .headingTypeface(readingTypeface(context, 600))
                    .headingTextSizeMultipliers(floatArrayOf(1.45f, 1.28f, 1.14f, 1.06f, 1f, 1f))
                    .headingBreakHeight(0).headingBreakColor(android.graphics.Color.TRANSPARENT)
                    .blockMargin(dp(18)).bulletWidth(dp(4)).listItemColor(colors.ink.toArgb())
                    .blockQuoteColor(colors.divider.toArgb()).blockQuoteWidth(dp(3))
                    .thematicBreakColor(colors.divider.toArgb()).thematicBreakHeight(dp(1))
            }
        }).build()
    private var source: String? = null
    private var streamSource: String? = null
    private var boundary = StreamingMarkdownBoundary()
    private var frozen = 0
    private var tail: TextView? = null
    private var pendingFormat: String? = null
    private val selectionChanged = ViewTreeObserver.OnPreDrawListener {
        val pending = pendingFormat
        if (pending != null && !containsSelection(this)) render(pending)
        true
    }
    init { orientation = VERTICAL }
    private fun dp(value: Int) = (resources.displayMetrics.density * value).toInt()

    fun render(markdown: String, streaming: Boolean = false, fade: Boolean = false) {
        if (streaming) {
            cancelPendingFormat()
            renderStream(markdown, fade)
            return
        }
        if (streamSource != null) {
            if (containsSelection(this)) {
                if (pendingFormat == null) viewTreeObserver.addOnPreDrawListener(selectionChanged)
                pendingFormat = markdown
                renderStream(markdown, false)
                return
            }
            cancelPendingFormat()
            resetStream()
        }
        if (source == markdown) return
        source = markdown
        renderBlocks(markdown, 0)
    }

    private fun cancelPendingFormat() {
        if (pendingFormat != null) viewTreeObserver.removeOnPreDrawListener(selectionChanged)
        pendingFormat = null
    }

    override fun onDetachedFromWindow() {
        cancelPendingFormat()
        super.onDetachedFromWindow()
    }

    private fun resetStream() {
        source = null
        streamSource = null
        frozen = 0
        tail = null
        boundary = StreamingMarkdownBoundary()
        removeAllViews()
    }

    private fun renderStream(markdown: String, fade: Boolean) {
        val previous = streamSource
        if (previous == markdown) return
        val appending = previous != null && markdown.startsWith(previous)
        if (!appending) resetStream()
        val previousLength = streamSource?.length ?: 0
        streamSource = markdown
        boundary.append(markdown)
        if (boundary.end > frozen && !containsSelection(this)) {
            tail?.let(::removeView)
            tail = null
            renderBlocks(markdown.substring(frozen, boundary.end), childCount)
            frozen = boundary.end
        }
        val view = tail ?: textView(context, bodyColor).apply {
            readingStyle(bodySize, bodyLineHeight)
            setTextColor(bodyColor)
            setText(markdown.substring(frozen, maxOf(frozen, previousLength)), TextView.BufferType.EDITABLE)
            addView(this, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                topMargin = if (childCount == 0) 0 else dp(20)
            })
            tail = this
        }
        val editable = view.editableText
        val start = editable.length
        editable.append(markdown, frozen + start, markdown.length)
        val now = SystemClock.uptimeMillis()
        editable.getSpans(0, start, StreamFade::class.java).forEach { if (now - it.started >= STREAM_FADE_MS) editable.removeSpan(it) }
        if (fade && appending && start < editable.length) {
            editable.setSpan(StreamFade(view, now), start, editable.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        // Setting TextView selection never requires switching Markdown modes.
    }

    private fun containsSelection(view: View): Boolean = when (view) {
        is TextView -> view.hasSelection()
        is ViewGroup -> (0 until view.childCount).any { containsSelection(view.getChildAt(it)) }
        else -> false
    }

    private fun renderBlocks(markdown: String, start: Int) {
        // Parse once with CommonMark, never split pipe-delimited text ourselves.
        val root = markwon.parse(normalizeMarkdownFileLinks(markdown))
        val blocks = mutableListOf<Any>()
        var pending = Document()
        fun flush() {
            if (pending.firstChild != null) { blocks += markwon.render(pending); pending = Document() }
        }
        var node = root.firstChild
        while (node != null) {
            val next = node.next
            if (node is TableBlock) { flush(); Table.parse(markwon, node)?.let { blocks += it } }
            else if (node is FencedCodeBlock) { flush(); blocks += CodeBlock(node.literal.trimEnd('\n'), node.info.orEmpty().substringBefore(' ')) }
            else if (node is IndentedCodeBlock) { flush(); blocks += CodeBlock(node.literal.trimEnd('\n'), "") }
            else pending.appendChild(node)
            node = next
        }
        flush()
        blocks.forEachIndexed { offset, block ->
            val index = start + offset
            val old = getChildAt(index)
            val view = when (block) {
                is Table -> (old as? MarkdownTable ?: MarkdownTable(context, colors)).also { it.onCell = ::linkFiles; it.setTable(block) }
                is CodeBlock -> (old as? MarkdownCodeBlock ?: MarkdownCodeBlock(context, colors)).also { it.setCode(block.code, block.language) }
                else -> (old as? TextView ?: textView(context, colors.ink.toArgb()).apply { readingStyle(bodySize, bodyLineHeight); setTextColor(bodyColor) }).also {
                    markwon.setParsedMarkdown(it, block as Spanned)
                    linkFiles(it)
                }
            }
            if (old !== view) {
                if (old != null) removeViewAt(index)
                addView(view, index, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
            }
            (view.layoutParams as LayoutParams).topMargin = if (index == 0) 0 else dp(20)
        }
        while (childCount > start + blocks.size) removeViewAt(childCount - 1)
    }

    private fun linkFiles(view: TextView) {
        val text = SpannableString(view.text)
        fun link(start: Int, end: Int, reference: FileReference) {
            text.setSpan(object : ClickableSpan() {
                override fun onClick(widget: View) { onFileOpen?.invoke(reference) }
                override fun updateDrawState(ds: TextPaint) { ds.color = colors.ink.toArgb(); ds.isUnderlineText = true }
            }, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        text.getSpans(0, text.length, URLSpan::class.java).forEach { span ->
            fileReference(span.url, allowUnknown = true)?.let { reference ->
                val start = text.getSpanStart(span); val end = text.getSpanEnd(span)
                text.removeSpan(span); link(start, end, reference)
            }
        }
        // Backticked paths are file references too, matching the PC chips.
        text.getSpans(0, text.length, io.noties.markwon.core.spans.CodeSpan::class.java).forEach { span ->
            val start = text.getSpanStart(span); val end = text.getSpanEnd(span)
            if (text.getSpans(start, end, ClickableSpan::class.java).isEmpty()) fileReference(text.substring(start, end))?.let { link(start, end, it) }
        }
        view.text = text
    }

    internal companion object {
        fun textView(context: Context, ink: Int) = TextView(context).apply {
            readingStyle()
            setTextColor(ink)
            setLinkTextColor(ink)
            setTextIsSelectable(true)
            movementMethod = LinkMovementMethod.getInstance()
            setPadding(0, 0, 0, 0)
        }
    }
}

private const val STREAM_FADE_MS = 220L
private class StreamFade(private val view: TextView, val started: Long) : CharacterStyle(), UpdateAppearance {
    override fun updateDrawState(paint: TextPaint) {
        val progress = ((SystemClock.uptimeMillis() - started).toFloat() / STREAM_FADE_MS).coerceIn(0f, 1f)
        val opacity = 1f - (1f - progress) * (1f - progress) * (1f - progress)
        paint.alpha = (paint.alpha * opacity).toInt()
        if (progress < 1f) view.postInvalidateOnAnimation()
    }
}

private data class CodeBlock(val code: String, val language: String)

/** A quiet code surface, with a real copy action and independent horizontal scrolling. */
private class MarkdownCodeBlock(context: Context, private val colors: MobileColors) : LinearLayout(context) {
    private val label = TextView(context)
    private val copy = TextView(context)
    private val codeView = TextView(context)
    private var original = ""
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    init {
        orientation = VERTICAL
        clipToOutline = true
        background = GradientDrawable().apply { setColor(this@MarkdownCodeBlock.colors.inset.toArgb()); cornerRadius = dp(12).toFloat() }
        val header = LinearLayout(context).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(16), 0, dp(6), 0) }
        label.readingStyle(12f, 18f, 500); label.setTextColor(colors.secondary.toArgb())
        copy.readingStyle(12f, 18f); copy.text = "复制代码"; copy.contentDescription = "复制代码"
        copy.gravity = Gravity.CENTER; copy.setTextColor(colors.secondary.toArgb()); copy.setPadding(dp(10), 0, dp(10), 0)
        copy.setOnClickListener { (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("代码", original)) }
        header.addView(label, LayoutParams(0, dp(42), 1f)); header.addView(copy, LayoutParams(LayoutParams.WRAP_CONTENT, dp(42)))
        label.gravity = Gravity.CENTER_VERTICAL
        addView(header, LayoutParams(LayoutParams.MATCH_PARENT, dp(42)))
        val scroll = HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; overScrollMode = View.OVER_SCROLL_NEVER }
        codeView.readingStyle(14f, 22f)
        codeView.setTextColor(colors.ink.toArgb()); codeView.setTextIsSelectable(true)
        codeView.setPadding(dp(16), 0, dp(16), dp(16))
        scroll.addView(codeView, ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        addView(scroll, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    }
    fun setCode(code: String, language: String) {
        if (code == original && label.text.toString() == language.ifBlank { "代码" }) return
        original = code; label.text = language.ifBlank { "代码" }.take(30)
        val extension = when (language.lowercase()) {
            "javascript" -> "js"; "typescript" -> "ts"; "python" -> "py"; "kotlin" -> "kt"
            "rust" -> "rs"; "shell", "bash", "powershell" -> "sh"; else -> language
        }
        val highlighted = if (code.length <= 40_000) highlightCode(code, "snippet.$extension", dark = colors.dark) else androidx.compose.ui.text.AnnotatedString(code)
        codeView.text = SpannableString(code).apply {
            highlighted.spanStyles.forEach { span -> setSpan(ForegroundColorSpan(span.item.color.toArgb()), span.start, span.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE) }
        }
    }
}

private class MarkdownTable(context: Context, private val colors: MobileColors) : HorizontalScrollView(context) {
    var onCell: ((TextView) -> Unit)? = null
    private val table = TableLayout(context)
    private var parsed: Table? = null
    private var available = 0
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    init {
        isFillViewport = true
        isHorizontalScrollBarEnabled = true
        overScrollMode = View.OVER_SCROLL_NEVER
        clipToOutline = true
        background = GradientDrawable().apply {
            setColor(this@MarkdownTable.colors.card.toArgb())
            cornerRadius = dp(12).toFloat()
            setStroke(dp(1), this@MarkdownTable.colors.divider.toArgb())
        }
        table.orientation = LinearLayout.VERTICAL
        table.showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE
        table.dividerDrawable = GradientDrawable().apply { setColor(this@MarkdownTable.colors.divider.toArgb()); setSize(1, dp(1)) }
        addView(table, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    }
    fun setTable(value: Table) { parsed = value; updateCells() }
    // Text selection also asks ancestors to reveal its caret, independently
    // of focus. A read-only table must keep the reader's horizontal position;
    // explicit swipes, keyboard scrolling and accessibility scroll actions
    // continue to use HorizontalScrollView's normal scrolling paths.
    override fun requestChildRectangleOnScreen(child: View, rectangle: Rect, immediate: Boolean): Boolean = false
    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (w != available) { available = w; updateCells() }
    }
    private fun updateCells() {
        val rows = parsed?.rows() ?: return
        val columns = rows.maxOfOrNull { it.columns().size } ?: return
        if (columns == 0) return
        val viewport = available.takeIf { it > 0 } ?: (resources.displayMetrics.widthPixels - dp(40))
        val widths = IntArray(columns) { index ->
            val longest = rows.maxOfOrNull { it.columns().getOrNull(index)?.content()?.length ?: 0 } ?: 0
            // Two-column summaries fit the phone; wider comparisons retain usable cell widths.
            if (columns <= 2) (viewport / columns).coerceAtLeast(dp(130))
            else dp((longest * 7 + 28).coerceIn(136, 220))
        }
        rows.forEachIndexed { r, row ->
            val rowView = (table.getChildAt(r) as? TableRow) ?: TableRow(context).also { table.addView(it) }
            rowView.setBackgroundColor(if (row.header()) colors.inset.toArgb() else android.graphics.Color.TRANSPARENT)
            row.columns().forEachIndexed { c, cell ->
                val text = (rowView.getChildAt(c) as? TextView) ?: MarkdownView.textView(context, colors.ink.toArgb()).also {
                    it.setOnTouchListener(TableLinkTouch())
                    rowView.addView(it)
                }
                // Selectable cells take focus on a tap. Do not make the outer
                // scroll view reveal the whole column when it is partly clipped.
                text.revealOnFocusHint = false
                text.readingStyle(15f, 24f, if (row.header()) 600 else 400)
                text.gravity = Gravity.TOP or when (cell.alignment()) { Table.Alignment.RIGHT -> Gravity.RIGHT; Table.Alignment.CENTER -> Gravity.CENTER_HORIZONTAL; else -> Gravity.LEFT }
                text.setPadding(dp(14), dp(13), dp(14), dp(13))
                text.text = cell.content()
                onCell?.invoke(text)
                text.layoutParams = TableRow.LayoutParams(widths[c], ViewGroup.LayoutParams.WRAP_CONTENT)
            }
            while (rowView.childCount > row.columns().size) rowView.removeViewAt(rowView.childCount - 1)
        }
        while (table.childCount > rows.size) table.removeViewAt(table.childCount - 1)
    }
}

/** Selectable TextViews otherwise consume the first link tap just to acquire focus. */
private class TableLinkTouch : View.OnTouchListener {
    private var pressed: ClickableSpan? = null
    private var startX = 0f
    private var startY = 0f
    private var moved = false
    private fun linkAt(view: TextView, event: MotionEvent): ClickableSpan? {
        val text = view.text as? Spanned ?: return null
        val layout = view.layout ?: return null
        val x = event.x - view.totalPaddingLeft + view.scrollX
        val y = event.y - view.totalPaddingTop + view.scrollY
        if (y < 0 || y >= layout.height) return null
        val line = layout.getLineForVertical(y.toInt())
        if (x < layout.getLineLeft(line) || x > layout.getLineRight(line)) return null
        val offset = layout.getOffsetForHorizontal(line, x)
        return text.getSpans(offset, offset, ClickableSpan::class.java).firstOrNull()
    }
    override fun onTouch(view: View, event: MotionEvent): Boolean {
        val cell = view as TextView
        val slop = ViewConfiguration.get(cell.context).scaledTouchSlop
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                pressed = linkAt(cell, event); startX = event.x; startY = event.y; moved = false
            }
            MotionEvent.ACTION_MOVE -> {
                if (kotlin.math.abs(event.x - startX) > slop || kotlin.math.abs(event.y - startY) > slop) moved = true
            }
            MotionEvent.ACTION_CANCEL -> pressed = null
            MotionEvent.ACTION_UP -> {
                val link = pressed; pressed = null
                if (link != null && !moved && kotlin.math.abs(event.x - startX) <= slop && kotlin.math.abs(event.y - startY) <= slop
                    && event.eventTime - event.downTime < ViewConfiguration.getLongPressTimeout() && linkAt(cell, event) === link) {
                    (cell.text as? Spannable)?.let { android.text.Selection.removeSelection(it) }
                    link.onClick(cell)
                    return true
                }
            }
        }
        // Keep native text selection and let the table/conversation own drags.
        return false
    }
}
