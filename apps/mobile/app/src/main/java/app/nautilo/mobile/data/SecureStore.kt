package app.nautilo.mobile.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Identity, trusted hosts, drafts and uncertain commands stay encrypted at rest. */
class SecureStore(context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "remote.v1"))
    private val key: SecretKey
    private var value: JSONObject
    init {
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        key = (keys.getKey("nautilo.remote.v1", null) as? SecretKey) ?: KeyGenerator.getInstance("AES", "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("nautilo.remote.v1", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
        value = if (file.baseFile.exists()) {
            val bytes = file.readFully()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
        } else JSONObject()
    }
    @Synchronized fun identity(): ByteArray {
        if (!value.has("identity")) {
            val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
            value.put("identity", java.util.Base64.getEncoder().encodeToString(bytes))
            save()
        }
        return java.util.Base64.getDecoder().decode(value.getString("identity"))
    }
    @Synchronized fun hosts(): List<Host> = value.objects("hosts").map(Host::decode)
    @Synchronized fun putHost(host: Host) {
        value.put("hosts", JSONArray((hosts().filterNot { it.id == host.id } + host).map { it.encode() }))
        value.put("selectedHost", host.id)
        save()
    }
    @Synchronized fun removeHost(id: String) {
        value.put("hosts", JSONArray(hosts().filterNot { it.id == id }.map { it.encode() }))
        value.put("outbox", JSONArray(commands().filterNot { it.hostId == id }.map { it.encode() }))
        if (value.text("selectedHost") == id) value.remove("selectedHost")
        save()
    }
    @Synchronized fun selectedHost(): Host? = hosts().find { it.id == value.text("selectedHost") } ?: hosts().firstOrNull()
    @Synchronized fun pendingHost(): Host? = value.optJSONObject("pendingHost")?.let(Host::decode)
    @Synchronized fun pairingCode(): String = value.text("pairingCode")
    @Synchronized fun pendingHost(host: Host?, code: String = "") {
        if (host == null) { value.remove("pendingHost"); value.remove("pairingCode") }
        else { value.put("pendingHost", host.encode()); value.put("pairingCode", code) }
        save()
    }
    @Synchronized fun selectHost(id: String) { value.put("selectedHost", id); save() }
    @Synchronized fun commands(): List<PendingCommand> = value.objects("outbox").map(PendingCommand::decode)
    @Synchronized fun putCommand(command: PendingCommand) {
        value.put("outbox", JSONArray((commands().filterNot { it.id == command.id } + command).map { it.encode() }))
        save()
    }
    @Synchronized fun finishCommand(id: String) {
        value.put("outbox", JSONArray(commands().filterNot { it.id == id }.map { it.encode() }))
        save()
    }
    @Synchronized fun draft(key: String): String = value.optJSONObject("drafts")?.text(key).orEmpty()
    @Synchronized fun draft(key: String, text: String) {
        val drafts = value.optJSONObject("drafts") ?: JSONObject()
        drafts.put(key, text)
        value.put("drafts", drafts)
        save()
    }
    private fun save() {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
        val bytes = cipher.iv + cipher.doFinal(value.toString().toByteArray())
        val output = file.startWrite()
        try { output.write(bytes); file.finishWrite(output) }
        catch (error: Exception) { file.failWrite(output); throw error }
    }
}
