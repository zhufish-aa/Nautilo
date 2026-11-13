package app.nautilo.mobile.ui

import android.content.Context
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.Spanned
import android.text.method.LinkMovementMethod
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TableLayout
import android.widget.TableRow
import android.widget.TextView
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
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
import org.commonmark.parser.Parser

@Composable fun Markdown(text: String, modifier: Modifier = Modifier) {
    AndroidView(factory = ::MarkdownView, modifier = modifier.fillMaxWidth(), update = { it.render(text) })
}

/** Native table cells remain selectable and wide tables scroll independently of the conversation. */
internal class MarkdownView(context: Context) : LinearLayout(context) {
    private val markwon = Markwon.builder(context)
        .usePlugin(StrikethroughPlugin.create())
        .usePlugin(object : AbstractMarkwonPlugin() {
            override fun configureParser(builder: Parser.Builder) {
                // Native cells render their inline children, without TextView's table span visitor.
                builder.extensions(listOf(TablesExtension.create()))
            }
            override fun configureTheme(builder: MarkwonTheme.Builder) {
                builder.linkColor(Blue.toArgb()).codeBackgroundColor(0xFFEFF3F6.toInt())
                    .codeTextColor(Ink.toArgb()).codeTypeface(resources.getFont(app.nautilo.mobile.R.font.jetbrains_mono)).blockMargin(dp(12))
            }
        }).build()
    private var source: String? = null
    init { orientation = VERTICAL }
    private fun dp(value: Int) = (resources.displayMetrics.density * value).toInt()

    fun render(markdown: String) {
        if (source == markdown) return
        source = markdown
        // Parse once with CommonMark, never split pipe-delimited text ourselves.
        val root = markwon.parse(markdown)
        val blocks = mutableListOf<Any>()
        var pending = Document()
        fun flush() {
            if (pending.firstChild != null) { blocks += markwon.render(pending); pending = Document() }
        }
        var node = root.firstChild
        while (node != null) {
            val next = node.next
            if (node is TableBlock) { flush(); Table.parse(markwon, node)?.let { blocks += it } }
            else pending.appendChild(node)
            node = next
        }
        flush()
        blocks.forEachIndexed { index, block ->
            val old = getChildAt(index)
            val view = when (block) {
                is Table -> (old as? MarkdownTable ?: MarkdownTable(context)).also { it.setTable(block) }
                else -> (old as? TextView ?: textView(context)).also { markwon.setParsedMarkdown(it, block as Spanned) }
            }
            if (old !== view) {
                if (old != null) removeViewAt(index)
                addView(view, index, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
            }
            (view.layoutParams as LayoutParams).topMargin = if (index == 0) 0 else dp(14)
        }
        while (childCount > blocks.size) removeViewAt(childCount - 1)
    }

    internal companion object {
        fun textView(context: Context) = TextView(context).apply {
            textSize = 15f
            setTextColor(Ink.toArgb())
            setLinkTextColor(Blue.toArgb())
            typeface = Typeface.create("sans-serif", Typeface.NORMAL)
            includeFontPadding = false
            setLineSpacing(2 * resources.displayMetrics.density, 1.22f)
            setTextIsSelectable(true)
            movementMethod = LinkMovementMethod.getInstance()
            setPadding(0, 0, 0, 0)
        }
    }
}

private class MarkdownTable(context: Context) : HorizontalScrollView(context) {
    private val table = TableLayout(context)
    private var parsed: Table? = null
    private var available = 0
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    init {
        isFillViewport = true
        isHorizontalScrollBarEnabled = true
        overScrollMode = View.OVER_SCROLL_NEVER
        clipToOutline = true
        background = GradientDrawable().apply { setColor(0xFFFEFEFF.toInt()); cornerRadius = dp(12).toFloat(); setStroke(dp(1), Line.toArgb()) }
        table.orientation = LinearLayout.VERTICAL
        table.showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE
        table.dividerDrawable = GradientDrawable().apply { setColor(Line.toArgb()); setSize(1, dp(1)) }
        addView(table, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    }
    fun setTable(value: Table) { parsed = value; updateCells() }
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
            rowView.setBackgroundColor(if (row.header()) 0xFFEDF4F9.toInt() else android.graphics.Color.TRANSPARENT)
            row.columns().forEachIndexed { c, cell ->
                val text = (rowView.getChildAt(c) as? TextView) ?: MarkdownView.textView(context).also { rowView.addView(it) }
                text.textSize = 13.5f
                text.typeface = Typeface.create("sans-serif", if (row.header()) Typeface.BOLD else Typeface.NORMAL)
                text.gravity = Gravity.TOP or when (cell.alignment()) { Table.Alignment.RIGHT -> Gravity.RIGHT; Table.Alignment.CENTER -> Gravity.CENTER_HORIZONTAL; else -> Gravity.LEFT }
                text.setPadding(dp(12), dp(11), dp(12), dp(11))
                text.text = cell.content()
                text.layoutParams = TableRow.LayoutParams(widths[c], ViewGroup.LayoutParams.WRAP_CONTENT)
            }
            while (rowView.childCount > row.columns().size) rowView.removeViewAt(rowView.childCount - 1)
        }
        while (table.childCount > rows.size) table.removeViewAt(table.childCount - 1)
    }
}
