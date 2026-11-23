package app.nautilo.mobile

import app.nautilo.mobile.data.*
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Base64

class ChatAttachmentTest {
    @Test fun storedTimelineKeepsPersistentImageMetadata() {
        val content = json("attachments" to JSONArray().put(json("id" to "artifact", "name" to "照片.jpg",
            "kind" to "image", "mimeType" to "image/jpeg", "sizeBytes" to 8, "uploadId" to "upload")))
        val snapshot = MobileTimeline.open(json("revision" to 1, "blocks" to JSONArray().put(
            json("seq" to 1, "blockId" to "message", "kind" to "user_prompt", "content" to content))))
        val image = ChatAttachment.decode(snapshot.blocks.single().content.objects("attachments").single())
        assertEquals("artifact", image.id)
        assertEquals("upload", image.cacheId)
        assertTrue(image.isImage)
        assertEquals("", image.localPath)
    }
    @Test fun phoneImageRemainsAvailableAfterPendingUploadIsDeletedAndAfterReopening() = runBlocking {
        val root = Files.createTempDirectory("nautilo-images-").toFile()
        try {
            val original = File(root, "upload").apply { writeBytes(byteArrayOf(1, 2, 3)) }
            val draft = DraftAttachment("upload", "照片.png", "image/png", 3, original.path)
            val cache = File(root, "cache")
            AttachmentImages(cache).retain("desktop", "session", draft)
            original.delete()
            val attachment = ChatAttachment("artifact", "照片.png", "image/png", 3, "image", "upload")
            val image = AttachmentImages(cache).load("desktop", "session", attachment) { error("Retained phone image should not be downloaded") }
            assertArrayEquals(byteArrayOf(1, 2, 3), image.readBytes())
        } finally { root.deleteRecursively() }
    }
    @Test fun desktopImageChunksStayContinuousAndCacheIsScopedToHostAndSession() = runBlocking {
        val root = Files.createTempDirectory("nautilo-images-").toFile()
        try {
            val images = AttachmentImages(root)
            val attachment = ChatAttachment("artifact", "desktop.png", "image/png", 5, "image")
            val offsets = mutableListOf<Long>()
            val bytes = byteArrayOf(1, 2, 3, 4, 5)
            val image = images.load("desktop", "one", attachment) { input ->
                val offset = input.getLong("offset"); offsets += offset
                val content = if (offset == 0L) bytes.copyOfRange(0, 3) else bytes.copyOfRange(3, 5)
                json("size" to 5, "offset" to offset, "modifiedAt" to "version", "base64" to Base64.getEncoder().encodeToString(content), "nextOffset" to if (offset == 0L) 3 else null)
            }
            assertArrayEquals(bytes, image.readBytes()); assertEquals(listOf(0L, 3L), offsets)
            assertEquals(image, images.load("desktop", "one", attachment) { error("Should be cached") })
            for ((host, session) in listOf("other" to "one", "desktop" to "two")) {
                var fetched = false
                images.load(host, session, attachment) { fetched = true; json("size" to 5, "offset" to 0, "modifiedAt" to "v", "base64" to Base64.getEncoder().encodeToString(bytes)) }
                assertTrue(fetched)
            }
        } finally { root.deleteRecursively() }
    }
    @Test fun changedImageCannotBeCachedFromMixedChunks() = runBlocking {
        val root = Files.createTempDirectory("nautilo-images-").toFile()
        try {
            try {
                AttachmentImages(root).load("desktop", "one", ChatAttachment("a", "a.png")) { input ->
                    val offset = input.getLong("offset")
                    json("size" to 4, "offset" to offset, "modifiedAt" to "v$offset", "base64" to "AQI=", "nextOffset" to 2)
                }
                fail("Mixed versions accepted")
            } catch (_: IllegalArgumentException) { assertTrue(root.listFiles().orEmpty().isEmpty()) }
        } finally { root.deleteRecursively() }
    }
}
