package app.nautilo.mobile.ui

import android.os.Bundle
import com.google.zxing.BarcodeFormat
import com.google.zxing.DecodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.MultiFormatReader
import com.google.zxing.Result
import com.google.zxing.ResultPoint
import com.journeyapps.barcodescanner.CaptureActivity
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.DecoderFactory
import com.journeyapps.barcodescanner.MixedDecoder
import com.journeyapps.barcodescanner.Size
import com.journeyapps.barcodescanner.camera.FitCenterStrategy

/** Pairing codes contain a full endpoint address, so decode the whole preview. */
class PairingCaptureActivity : CaptureActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val scanner = findViewById<DecoratedBarcodeView>(com.google.zxing.client.android.R.id.zxing_barcode_scanner)
        // CaptureManager applies intent defaults in super.onCreate. Configure the
        // camera afterwards, before onResume opens it, so they cannot reset focus.
        scanner.cameraSettings = scanner.cameraSettings.apply {
            isAutoFocusEnabled = true
            isContinuousFocusEnabled = true
        }
        scanner.barcodeView.apply {
            previewScalingStrategy = FitCenterStrategy()
            // The default viewfinder crops decoding to a small square. Clamping
            // this rectangle to the view keeps all three QR finder patterns and
            // their quiet zones, including on narrow portrait screens.
            val display = resources.displayMetrics
            framingRectSize = Size(display.widthPixels, display.heightPixels)
        }
        scanner.decoderFactory = pairingQrDecoderFactory()
    }
}

internal fun pairingQrDecoderFactory() = DecoderFactory { baseHints ->
    val hints = mutableMapOf<DecodeHintType, Any>()
    baseHints.forEach { (key, value) -> if (value != null) hints[key] = value }
    hints[DecodeHintType.POSSIBLE_FORMATS] = listOf(BarcodeFormat.QR_CODE)
    hints[DecodeHintType.TRY_HARDER] = true
    hints[DecodeHintType.CHARACTER_SET] = "UTF-8"
    val reader = MultiFormatReader().apply { setHints(hints) }
    object : MixedDecoder(reader) {
        private var rotated = false
        private var sourceHeight = 0
        override fun decode(source: LuminanceSource): Result? {
            rotated = false
            // Try both polarities of the same frame before requesting another.
            super.decode(source)?.let { return it }
            super.decode(source)?.let { return it }
            // The detector can miss dense, sideways codes in a wide full-frame
            // preview. Rotate the luminance plane, retaining the complete image.
            rotated = true
            sourceHeight = source.height
            val sideways = RotatedQrSource(source)
            return super.decode(sideways) ?: super.decode(sideways)
        }
        override fun getPossibleResultPoints(): MutableList<ResultPoint> = super.getPossibleResultPoints().map {
            if (rotated) ResultPoint(it.y, sourceHeight - it.x - 1) else it
        }.toMutableList()
    }
}

private class RotatedQrSource(source: LuminanceSource) : LuminanceSource(source.height, source.width) {
    private val pixels = ByteArray(width * height).also { output ->
        val input = source.matrix
        for (y in 0 until source.height) for (x in 0 until source.width)
            output[x * source.height + source.height - y - 1] = input[y * source.width + x]
    }
    override fun getMatrix(): ByteArray = pixels
    override fun getRow(y: Int, row: ByteArray?): ByteArray = (row?.takeIf { it.size >= width } ?: ByteArray(width)).also {
        pixels.copyInto(it, 0, y * width, (y + 1) * width)
    }
}
