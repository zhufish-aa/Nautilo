package app.nautilo.mobile

import app.nautilo.mobile.data.PairingInvitation
import app.nautilo.mobile.data.json
import app.nautilo.mobile.ui.pairingQrDecoderFactory
import com.google.zxing.BarcodeFormat
import com.google.zxing.DecodeHintType
import com.google.zxing.EncodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

class PairingQrDecoderTest {
    private fun invitation(): String {
        val addresses = JSONArray().put(json("Relay" to "https://relay.example.test/"))
        repeat(8) { addresses.put(json("Ip" to "[2001:db8:abcd:1234::${it + 1}]:12345")) }
        val payload = json("v" to 1, "transport" to "iroh", "alpn" to "nautilo/remote/1",
            "name" to "开发电脑", "endpoint" to json("id" to "ab".repeat(32), "addrs" to addresses),
            "token" to "safe-test-token".repeat(3), "expiresAt" to 4_102_444_800_000L)
        return "nautilo://pair#" + Base64.getUrlEncoder().withoutPadding().encodeToString(payload.toString().toByteArray())
    }

    private data class Frame(val width: Int, val height: Int, val pixels: IntArray) {
        fun source() = RGBLuminanceSource(width, height, pixels)
        fun rotate(): Frame {
            val rotated = IntArray(pixels.size)
            for (y in 0 until height) for (x in 0 until width)
                rotated[x * height + height - y - 1] = pixels[y * width + x]
            return Frame(height, width, rotated)
        }
    }

    private fun frame(uri: String, left: Int = 160, top: Int = 350): Frame {
        val qr = QRCodeWriter().encode(uri, BarcodeFormat.QR_CODE, 384, 384,
            mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 4))
        val width = 720
        val height = 1280
        val pixels = IntArray(width * height) { 0xffcccccc.toInt() }
        for (y in 0 until qr.height) for (x in 0 until qr.width)
            pixels[(top + y) * width + left + x] = if (qr[x, y]) 0xff000000.toInt() else 0xffffffff.toInt()
        return Frame(width, height, pixels)
    }

    private fun decode(source: LuminanceSource): String? {
        val decoder = pairingQrDecoderFactory().createDecoder(emptyMap<DecodeHintType, Any>())
        repeat(2) { decoder.decode(source)?.let { return it.text } }
        return null
    }

    @Test fun densePairingCodeDecodesAndKeepsTheOriginalPayload() {
        val uri = invitation()
        assertTrue(uri.length > 800)
        val decoded = decode(frame(uri).source())
        assertEquals(uri, decoded)
        val pairing = PairingInvitation.parse(requireNotNull(decoded), now = 1000)
        assertEquals("开发电脑", pairing.host.name)
        assertEquals("ab".repeat(32), pairing.host.id)
        assertEquals("safe-test-token".repeat(3), pairing.token)
    }

    @Test fun fullPreviewRetainsFinderPatternsOutsideTheDefaultSquare() {
        val uri = invitation()
        val image = frame(uri, left = 16, top = 300).source()
        // The former central viewfinder excludes QR finder patterns here.
        assertNull(decode(image.crop(72, 352, 576, 576)))
        assertEquals(uri, decode(image))
    }

    @Test fun rotatedAndInvertedCameraFramesRemainReadable() {
        val uri = invitation()
        var image = frame(uri)
        repeat(4) {
            assertEquals(uri, decode(image.source()))
            assertEquals(uri, decode(image.source().invert()))
            image = image.rotate()
        }
    }
}
