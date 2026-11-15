package app.nautilo.mobile

import app.nautilo.mobile.data.copyAttachment
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

class AttachmentCopyTest {
    @Test fun unknownSizeStreamsAreBoundedBeforeWritingExcessBytes() {
        val output = ByteArrayOutputStream()
        try { copyAttachment(ByteArrayInputStream(ByteArray(4096)), output, 1024); fail("Oversize stream accepted") }
        catch (_: IllegalArgumentException) { assertEquals(0, output.size()) }
        val content = "附件内容".toByteArray()
        val accepted = ByteArrayOutputStream()
        assertEquals(content.size.toLong(), copyAttachment(ByteArrayInputStream(content), accepted, content.size.toLong()))
        assertArrayEquals(content, accepted.toByteArray())
    }
}
