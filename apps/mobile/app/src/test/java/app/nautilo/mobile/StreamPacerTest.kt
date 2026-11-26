package app.nautilo.mobile

import app.nautilo.mobile.data.StreamPacer
import app.nautilo.mobile.data.StreamingMarkdownBoundary
import org.junit.Assert.*
import org.junit.Test

class StreamPacerTest {
    private fun buffer() = StreamPacer { Regex("\\X").findAll(it).map { cluster -> cluster.range.last + 1 }.toList() }

    @Test fun burstAndFinalDrainHaveTheSameTimingAtDifferentRefreshRates() {
        for (hz in listOf(60, 120, 144, 240)) {
            val pacer = buffer()
            val source = "流式 👩🏽‍💻 ".repeat(600)
            pacer.update(source, live = true, animate = true)
            assertEquals("", pacer.frame(0))
            val frame = 1_000_000_000L / hz
            val early = pacer.frame(frame)
            assertTrue(early.isNotEmpty() && early.length < source.length)
            for (index in 2..(hz * 0.31).toInt()) pacer.frame(index * frame)
            assertEquals("refresh rate $hz", source, pacer.text)
            pacer.update(source + "结束🙂".repeat(120), live = true, animate = true)
            pacer.frame(1_000_000_000L)
            pacer.frame(1_000_000_000L + frame)
            val final = source + "结束🙂".repeat(120)
            pacer.update(final, live = false, animate = true)
            for (index in 2..(hz * 0.20).toInt()) pacer.frame(1_000_000_000L + index * frame)
            assertEquals("final drain at $hz", final, pacer.text)
        }
    }

    @Test fun graphemesSurvivePacketBoundariesAndStaticOutputIsImmediate() {
        val pacer = buffer()
        pacer.update("A", live = true, animate = false)
        pacer.update("A👩🏽‍💻e\u0301🇹🇼\uD83D", live = true, animate = true)
        val complete = "A👩🏽‍💻e\u0301🇹🇼"
        val ends = Regex("\\X").findAll(complete).map { it.range.last + 1 }.toSet()
        for (index in 0..24) assertTrue(pacer.frame(index * 16_666_667L).length in ends)
        assertEquals(complete, pacer.text)
        pacer.update(complete + "🙂", live = false, animate = false)
        assertEquals(complete + "🙂", pacer.text)
        assertFalse(pacer.pending)
    }

    @Test fun blankLinesInsideCodeOrListsDoNotReleaseAnIncompleteBlock() {
        val boundary = StreamingMarkdownBoundary()
        val first = "开头\n\n~~~kotlin\n第一行\n\n下一行\n"
        boundary.append(first)
        assertEquals("开头\n\n".length, boundary.end)
        val code = first + "~~~\n\n"
        boundary.append(code + "- 项目\n\n  仍属于列表\n")
        assertEquals("开头\n\n".length, boundary.end)
        val prefix = code + "- 项目\n\n  仍属于列表\n\n"
        boundary.append(prefix + "新段落\n")
        assertEquals(prefix.length, boundary.end)
    }
}
