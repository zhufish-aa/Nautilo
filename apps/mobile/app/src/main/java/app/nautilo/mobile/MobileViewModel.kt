package app.nautilo.mobile

import android.app.Application
import android.os.Build
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.nautilo.mobile.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import org.json.JSONObject
import org.json.JSONArray
import java.util.Base64
import java.time.Instant
import java.util.UUID
import kotlin.random.Random

enum class Screen { Projects, NewConversation, Chat, Workspace, FileDiff, Computers, ProjectFiles, FilePreview }
data class MobileState(
    val screen: Screen = Screen.Projects,
    val hosts: List<Host> = emptyList(), val host: Host? = null,
    val connected: Boolean = false, val connecting: Boolean = false,
    val path: String = "", val latency: Long? = null, val system: String = "",
    val capabilities: Set<String> = emptySet(),
    val connectStage: String = "",
    val error: String = "", val pairingCode: String = "", val pairing: Boolean = false,
    val projects: List<Project> = emptyList(), val sessions: List<Conversation> = emptyList(),
    val session: Conversation? = null, val messages: List<ChatMessage> = emptyList(),
    val activities: List<ActivityItem> = emptyList(), val busy: Boolean = false,
    val runId: String = "", val runStatus: String = "", val elapsed: Long = 0,
    val runError: String = "",
    val runs: List<RunInfo> = emptyList(),
    val draft: String = "", val newDraft: String = "", val readOnly: Boolean = false, val hasOlder: Boolean = false,
    val draftAttachments: List<DraftAttachment> = emptyList(), val newAttachments: List<DraftAttachment> = emptyList(), val attachmentLoading: Boolean = false,
    val models: List<JSONObject> = emptyList(), val modelsLoading: Boolean = false,
    val workspace: List<JSONObject> = emptyList(), val workspaceLoading: Boolean = false,
    val diffPath: String = "",
    val members: List<JSONObject> = emptyList(), val interactions: List<JSONObject> = emptyList(),
    val approvals: List<JSONObject> = emptyList(), val changing: Boolean = false,
    val setup: JSONObject = JSONObject(), val setupLoading: Boolean = false,
    val newModels: List<JSONObject> = emptyList(), val catalogLoading: Boolean = false,
    val newConversationProjectId: String? = null,
    val modes: JSONObject = JSONObject(), val modesKey: String = "", val modesLoading: Boolean = false,
    val directory: JSONObject = JSONObject(), val directoryLoading: Boolean = false,
    val fileProject: Project? = null, val projectFiles: JSONObject = JSONObject(), val projectFilesLoading: Boolean = false,
    val filePreview: RemoteFilePreview = RemoteFilePreview(), val previewBack: Screen = Screen.Chat, val filesBack: Screen = Screen.Projects,
)

class MobileViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as NautiloApplication
    private val store = app.store
    private val peer = app.peer
    private val attachmentFiles = AttachmentFiles(application)
    private val attachmentImages = AttachmentImages(java.io.File(application.cacheDir, "chat-attachment-images"))
    suspend fun attachmentImage(attachment: ChatAttachment, sessionId: String): java.io.File {
        val host = state.value.host ?: error("请先连接电脑")
        return attachmentImages.load(host.id, sessionId, attachment) { input -> peer.call(host, "attachment.read", input) }
    }
    private val mutable = MutableStateFlow(MobileState(hosts = store.hosts(), host = store.selectedHost()))
    val state = mutable.asStateFlow()
    private var connectionJob: Job? = null
    private var sessionJob: Job? = null
    private var projection = SessionProjection()
    private val visibility = MutableStateFlow(false)
    private val foreground get() = visibility.value
    private val connectionWake = Channel<Unit>(Channel.CONFLATED)
    private var sessionGeneration = 0
    private var connectionGeneration = 0
    private val commandLock = kotlinx.coroutines.sync.Mutex()
    private var draftJob: Job? = null
    private var attachmentGeneration = 0
    private var fileJob: Job? = null
    private var filesJob: Job? = null
    private var fileGeneration = 0
    private var filesGeneration = 0
    init {
        viewModelScope.launch { peer.phase.collect { phase ->
            mutable.update { it.copy(connectStage = phase, connected = it.connected && phase == "ready") }
            if (phase == "ready" && foreground) connectionWake.trySend(Unit)
        } }
        viewModelScope.launch { app.connectionPaused.collect { paused -> if (paused) {
            connectionGeneration++; connectionJob?.cancel(); sessionJob?.cancel()
            mutable.update { it.copy(connected = false, connecting = false, connectStage = "") }
        } } }
    }

    fun foreground(active: Boolean) {
        if (foreground == active) return
        visibility.value = active
        if (active) {
            val pending = store.pendingHost()
            if (pending != null) resumePairing(pending) else startConnection()
            connectionWake.trySend(Unit)
            if (state.value.connected && state.value.session != null && sessionJob?.isActive != true) watchSession(state.value.session!!)
        }
        // An outstanding long poll may finish in the background. The loop
        // checks visibility before starting another, so a quick return can
        // reuse the same request instead of leaving a server-side waiter.
    }
    private fun cancelFileRequests() { fileGeneration++; filesGeneration++; fileJob?.cancel(); filesJob?.cancel() }
    fun navigate(screen: Screen) {
        if (screen !in listOf(Screen.ProjectFiles, Screen.FilePreview)) cancelFileRequests()
        mutable.update { it.copy(screen = screen, filePreview = if (screen == Screen.FilePreview) it.filePreview else RemoteFilePreview()) }
    }
    fun clearError() { mutable.update { it.copy(error = "") } }
    fun openProjectFiles(projectId: String) {
        val project = state.value.projects.find { it.id == projectId } ?: return
        saveDraft()
        cancelFileRequests()
        mutable.update { it.copy(screen = Screen.ProjectFiles, fileProject = project, projectFiles = JSONObject(),
            filePreview = RemoteFilePreview(), filesBack = when (it.screen) {
                Screen.FilePreview -> if (it.previewBack == Screen.ProjectFiles) it.filesBack else it.previewBack
                Screen.ProjectFiles -> it.filesBack; else -> it.screen
            }) }
        browseProjectFiles()
    }
    fun browseProjectFiles(path: String = "", offset: Int = 0, query: String = "") {
        val generation = ++filesGeneration
        filesJob?.cancel()
        val s = state.value; val host = s.host ?: return; val project = s.fileProject ?: return
        if ("project.files" !in s.capabilities) { mutable.update { it.copy(error = "请更新电脑端以浏览项目文件") }; return }
        filesJob = viewModelScope.launch {
            mutable.update { it.copy(projectFilesLoading = true, error = "") }
            try {
                val page = peer.call(host, "project.files", json("projectId" to project.id, "path" to path, "offset" to offset, "query" to query))
                if (offset > 0) page.put("entries", JSONArray(state.value.projectFiles.objects("entries") + page.objects("entries")))
                if (generation == filesGeneration) mutable.update { it.copy(projectFiles = page) }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (generation == filesGeneration) mutable.update { it.copy(error = readableError(error)) } }
            finally { if (generation == filesGeneration) mutable.update { it.copy(projectFilesLoading = false) } }
        }
    }
    fun previewFile(reference: FileReference, more: Boolean = false) {
        val s = state.value; val host = s.host ?: return
        val project = if (s.screen in listOf(Screen.ProjectFiles, Screen.FilePreview)) s.fileProject
            else s.projects.find { it.id == s.session?.projectId }
        if (project == null) return
        if ("file.preview" !in s.capabilities) { mutable.update { it.copy(error = "请更新电脑端以预览文件") }; return }
        val generation = ++fileGeneration
        fileJob?.cancel()
        val previous = if (more) s.filePreview else RemoteFilePreview(path = reference.path, line = reference.line)
        var requestedPath = reference.path
        if (!more && s.screen == Screen.FilePreview) {
            val relative = requestedPath.replace('\\', '/')
            if (relative.contains('/') && !relative.startsWith('/') && !Regex("^[A-Za-z]:/").containsMatchIn(relative)) {
                val folder = s.filePreview.path.replace('\\', '/').substringBeforeLast('/', "")
                if (folder.isNotEmpty()) requestedPath = "$folder/$relative"
            }
        }
        val back = if (s.screen == Screen.FilePreview) s.previewBack else s.screen
        mutable.update { it.copy(screen = Screen.FilePreview, fileProject = project, previewBack = back,
            filePreview = previous.copy(loading = true, error = "")) }
        fileJob = viewModelScope.launch {
            try {
                val offset = if (more) previous.nextOffset ?: return@launch else 0
                val page = peer.call(host, "file.preview", json("projectId" to project.id, "path" to requestedPath, "offset" to offset))
                if (generation != fileGeneration) return@launch
                if (page.has("candidates")) {
                    val candidates = page.strings("candidates")
                    mutable.update { it.copy(filePreview = previous.copy(candidates = candidates,
                        error = if (candidates.isEmpty()) "没有找到此文件，请在项目文件中浏览" else "找到多个同名文件，请选择完整路径")) }
                    return@launch
                }
                val modified = page.text("modifiedAt")
                if (more && previous.modifiedAt != modified) throw IllegalStateException("文件已更新，请刷新后重新读取")
                var data = withContext(Dispatchers.Default) {
                    val decoded = Base64.getDecoder().decode(page.text("base64"))
                    if (more) previous.bytes + decoded else decoded
                }
                val path = page.text("path", reference.path)
                var next = if (page.isNull("nextOffset")) null else page.optInt("nextOffset")
                val mime = page.text("mimeType")
                // Images and PDF need complete bytes; prefetch at most three
                // chunks concurrently so relay latency is not paid serially.
                if ((mime.startsWith("image/") || mime == "application/pdf") && next != null) {
                    val first = next!!
                    val length = page.optInt("size")
                    val slots = Semaphore(3)
                    val chunks = coroutineScope { (first until length step 524_288).map { at -> async {
                        slots.withPermit {
                            val part = peer.call(host, "file.preview", json("projectId" to project.id, "path" to path, "offset" to at))
                            check(part.text("modifiedAt") == modified) { "文件已更新，请刷新后重新读取" }
                            Base64.getDecoder().decode(part.text("base64"))
                        }
                    } }.awaitAll() }
                    data = withContext(Dispatchers.Default) {
                        val output = java.io.ByteArrayOutputStream(length)
                        output.write(data); chunks.forEach { output.write(it) }; output.toByteArray()
                    }; next = null
                }
                if (generation == fileGeneration) mutable.update { it.copy(filePreview = RemoteFilePreview(path, mime, page.optLong("size"), modified, data, next,
                    line = previous.line)) }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (generation == fileGeneration) mutable.update { it.copy(filePreview = it.filePreview.copy(error = readableError(error))) } }
            finally { if (generation == fileGeneration) mutable.update { it.copy(filePreview = it.filePreview.copy(loading = false)) } }
        }
    }
    fun closeFilePreview() { fileGeneration++; fileJob?.cancel(); mutable.update { it.copy(screen = it.previewBack, filePreview = RemoteFilePreview()) } }
    fun draft(text: String) {
        mutable.update { it.copy(draft = text) }
        draftJob?.cancel()
        draftJob = viewModelScope.launch { delay(500); saveDraft() }
    }
    fun saveDraft() {
        val s = state.value
        s.session?.let { store.draft("${s.host?.id}:${it.id}", s.draft) }
        s.host?.let { store.draft("new:${it.id}", s.newDraft) }
    }
    fun beginConversation(projectId: String? = null) {
        saveDraft()
        mutable.update { it.copy(screen = Screen.NewConversation, newConversationProjectId = projectId,
            newDraft = store.draft("new:${it.host?.id}"), newAttachments = store.attachments("new:${it.host?.id}"), error = "") }
        loadSetup()
    }
    fun newDraft(text: String) {
        mutable.update { it.copy(newDraft = text) }
        draftJob?.cancel()
        draftJob = viewModelScope.launch { delay(500); saveDraft() }
    }
    fun addAttachments(uris: List<Uri>, newConversation: Boolean = false) {
        val current = state.value
        val host = current.host ?: return
        val key = if (newConversation) "new:${host.id}" else "${host.id}:${current.session?.id ?: return}"
        if (current.attachmentLoading || current.readOnly) return
        val generation = ++attachmentGeneration
        mutable.update { it.copy(attachmentLoading = true) }
        viewModelScope.launch {
            val imported = mutableListOf<DraftAttachment>()
            try {
                val previous = store.attachments(key)
                require(previous.size + uris.size <= DraftAttachment.MAX_FILES) { "每条消息最多添加 10 个附件" }
                withContext(Dispatchers.IO) { uris.forEach { imported += attachmentFiles.import(it) } }
                val files = previous + imported
                store.attachments(key, files)
                if (generation == attachmentGeneration && state.value.host?.id == host.id) mutable.update {
                    if (newConversation) it.copy(newAttachments = files)
                    else if (it.session?.id == current.session?.id) it.copy(draftAttachments = files) else it
                }
            } catch (error: Exception) {
                imported.forEach(attachmentFiles::remove)
                if (error is CancellationException) throw error
                mutable.update { it.copy(error = readableError(error)) }
            } finally { if (generation == attachmentGeneration && state.value.host?.id == host.id) mutable.update { it.copy(attachmentLoading = false) } }
        }
    }
    fun removeAttachment(file: DraftAttachment, newConversation: Boolean = false) {
        val s = state.value
        val key = if (newConversation) "new:${s.host?.id}" else "${s.host?.id}:${s.session?.id}"
        val files = store.attachments(key).filterNot { it.id == file.id }
        store.attachments(key, files)
        mutable.update { if (newConversation) it.copy(newAttachments = files) else it.copy(draftAttachments = files) }
        attachmentFiles.remove(file)
    }
    fun selectHost(host: Host) {
        saveDraft()
        cancelFileRequests()
        connectionGeneration++; sessionGeneration++
        connectionJob?.cancel(); sessionJob?.cancel()
        projection = SessionProjection()
        store.selectHost(host.id)
        mutable.value = MobileState(hosts = store.hosts(), host = host, screen = Screen.Projects)
        startConnection()
    }
    fun removeHost(host: Host) {
        store.removeHost(host.id)
        if (state.value.host?.id == host.id) {
            cancelFileRequests()
            ConnectionService.pause(app)
            connectionGeneration++; sessionGeneration++
            connectionJob?.cancel(); sessionJob?.cancel()
            mutable.value = MobileState(hosts = store.hosts(), host = store.selectedHost(), screen = Screen.Computers)
            viewModelScope.launch { peer.disconnect(); startConnection() }
        } else mutable.update { it.copy(hosts = store.hosts()) }
    }
    fun pair(uri: String) {
        val invite = try { PairingInvitation.parse(uri.trim()) } catch (error: Exception) {
            mutable.update { it.copy(error = error.message.orEmpty()) }; return
        }
        if (state.value.pairing) return
        ConnectionService.pause(app)
        store.hosts().find { it.id == invite.host.id }?.let {
            val refreshed = invite.host.copy(pairedAt = it.pairedAt)
            store.putHost(refreshed)
            selectHost(refreshed)
            return
        }
        saveDraft()
        connectionGeneration++; sessionGeneration++
        connectionJob?.cancel(); sessionJob?.cancel()
        connectionJob = viewModelScope.launch {
            mutable.update { it.copy(pairing = true, pairingCode = "", connected = false, connecting = true, error = "", screen = Screen.Computers) }
            try {
                peer.disconnect()
                val phoneId = peer.identity()
                val code = invite.verificationCode(phoneId)
                val reply = peer.call(invite.host, "pair", json("name" to Build.MODEL.take(100), "token" to invite.token))
                require(reply.text("code").isEmpty() || reply.text("code") == code) { "配对码不匹配" }
                store.pendingHost(invite.host, code)
                mutable.update { it.copy(pairingCode = code, connecting = false) }
                withTimeout(120_000) {
                    while (isActive) {
                        delay(1500)
                        when (peer.call(invite.host, "pair.status").text("state")) {
                            "paired" -> break
                            "expired" -> throw RemoteFailure("PAIRING_EXPIRED", "配对已过期或被拒绝")
                        }
                    }
                }
                store.putHost(invite.host)
                store.pendingHost(null)
                mutable.update { it.copy(host = invite.host, hosts = store.hosts(), pairing = false, pairingCode = "", screen = Screen.Projects) }
                connectionJob = null
                startConnection()
            } catch (cancelled: CancellationException) {
                mutable.update { it.copy(pairing = false, pairingCode = "", connecting = false) }
                if (cancelled is TimeoutCancellationException) mutable.update { it.copy(error = "等待确认超时，请在电脑上重新生成配对码") }
                else throw cancelled
            } catch (error: Exception) {
                mutable.update { it.copy(pairing = false, pairingCode = "", connecting = false, error = readableError(error)) }
            }
        }
    }
    private fun resumePairing(host: Host) {
        ConnectionService.pause(app)
        connectionJob?.cancel()
        connectionJob = viewModelScope.launch {
            mutable.update { it.copy(pairing = true, pairingCode = store.pairingCode(), screen = Screen.Computers) }
            try {
                withTimeout(120_000) {
                    while (isActive) {
                        when (peer.call(host, "pair.status").text("state")) {
                            "paired" -> break
                            "expired" -> { store.pendingHost(null); throw RemoteFailure("PAIRING_EXPIRED", "配对已过期或被拒绝") }
                        }
                        delay(1500)
                    }
                }
                store.putHost(host); store.pendingHost(null)
                mutable.update { it.copy(host = host, hosts = store.hosts(), pairing = false, pairingCode = "", screen = Screen.Projects) }
                startConnection()
            } catch (cancelled: CancellationException) { mutable.update { it.copy(pairing = false) }; throw cancelled }
            catch (error: Exception) { mutable.update { it.copy(pairing = false, error = readableError(error)) } }
        }
    }
    fun cancelPairing() {
        connectionJob?.cancel()
        store.pendingHost(null)
        mutable.update { it.copy(pairing = false, pairingCode = "", connecting = false) }
        viewModelScope.launch { peer.disconnect(); startConnection() }
    }
    fun retry() { connectionJob?.cancel(); startConnection() }

    private fun startConnection() {
        val host = state.value.host ?: return
        if (!foreground || state.value.pairing) return
        app.connectionPaused.value = false
        try { ConnectionService.start(app) } catch (error: RuntimeException) {
            mutable.update { it.copy(error = "后台连接服务未启动：${error.message.orEmpty()}") }
        }
        if (connectionJob?.isActive == true) return
        connectionJob?.cancel()
        val generation = ++connectionGeneration
        connectionJob = viewModelScope.launch {
            var failures = 0
            while (isActive && generation == connectionGeneration) {
                visibility.first { it }
                try {
                    mutable.update { if (it.connected) it else it.copy(connecting = true, connectStage = "connecting", error = "") }
                    val hello = peer.call(host, "hello")
                    if (generation != connectionGeneration) return@launch
                    hello.optJSONObject("endpoint")?.takeIf { it.text("id") == host.id }?.let { address ->
                        val current = store.hosts().find { it.id == host.id } ?: host
                        if (current.endpoint.toString() != address.toString()) store.refreshHost(current.copy(endpoint = address))
                    }
                    mutable.update { it.copy(connected = true, connecting = false, error = "", system = hello.text("system"),
                        capabilities = hello.strings("capabilities").toSet(), hosts = store.hosts(),
                        readOnly = false, path = peer.path(), latency = peer.latency()) }
                    flushOutbox(host)
                    if (state.value.projects.isEmpty() || state.value.screen == Screen.Projects) refreshProjects(host)
                    if (sessionJob?.isActive != true && state.value.session != null) watchSession(state.value.session!!)
                    failures = 0
                    withTimeoutOrNull(20_000) { connectionWake.receive() }
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    mutable.update { if (error.isConnectionFailure()) it.copy(connected = false, connecting = false, connectStage = "failed", error = readableError(error))
                        else it.copy(connecting = false, error = readableError(error)) }
                    if (error is RemoteFailure && error.code == "DEVICE_NOT_AUTHORIZED") break
                    delay((1000L shl failures.coerceAtMost(4)) + Random.nextLong(500))
                    failures++
                }
            }
        }
    }
    private suspend fun refreshProjects(host: Host) {
        val projects = peer.call(host, "projects.list").objects("projects").map { Project(it.getString("id"), it.text("name"), it.text("rootPath")) }
        val slots = Semaphore(3)
        val sessions = coroutineScope { projects.map { project -> async { slots.withPermit {
            val sessions = mutableListOf<Conversation>()
            var offset: Int? = 0
            while (offset != null && offset < 10_000) {
                val page = peer.call(host, "sessions.list", json("projectId" to project.id, "offset" to offset, "limit" to 200))
                sessions += page.objects("sessions").map(Conversation::decode)
                offset = if (page.isNull("nextOffset")) null else page.optInt("nextOffset")
            }
            sessions
        } } }.awaitAll().flatten() }
        if (state.value.host?.id == host.id) mutable.update { it.copy(projects = projects, sessions = sessions.sortedByDescending(Conversation::updatedAt)) }
    }
    fun openSession(session: Conversation) {
        saveDraft()
        sessionGeneration++; sessionJob?.cancel()
        projection = SessionProjection()
        val host = state.value.host ?: return
        mutable.update { it.copy(session = session, screen = Screen.Chat, messages = emptyList(), activities = emptyList(), busy = true,
            models = emptyList(), workspace = emptyList(), interactions = emptyList(), approvals = emptyList(), runs = emptyList(), runId = "", runStatus = "", error = "",
            draft = store.draft("${host.id}:${session.id}"), draftAttachments = store.attachments("${host.id}:${session.id}")) }
        watchSession(session)
    }
    private fun watchSession(session: Conversation) {
        val host = state.value.host ?: return
        val generation = sessionGeneration
        sessionJob?.cancel()
        sessionJob = viewModelScope.launch {
            try {
                if (projection.epoch.isEmpty()) {
                    val page = peer.call(host, "session.history", json("sessionId" to session.id))
                    if (generation != sessionGeneration) return@launch
                    projection.history(page, initialize = true)
                }
                for (command in store.commands().filter { it.hostId == host.id && it.sessionId == session.id }) {
                    val id = PendingCommand.stableMessageId(peer.identity(), command.id)
                    projection.optimistic(ChatMessage(id, "user", command.params.text("text").ifBlank { "请查看附件。" }, command.createdAt, "waiting", attachmentNames = command.params.objects("_attachments").map { it.text("name") }, attachments = command.params.objects("_attachments").map { ChatAttachment.draft(DraftAttachment.decode(it)) }))
                }
                refreshSession(host, session.id)
                publish()
                while (isActive && foreground && generation == sessionGeneration) {
                    val events = peer.call(host, "events.wait", json("sessionId" to session.id, "epoch" to projection.epoch, "afterSequence" to projection.sequence))
                    if (generation != sessionGeneration) return@launch
                    val changes = events.objects("events")
                    changes.forEach { projection.apply(it) }
                    publish()
                    if (changes.any { it.text("type").startsWith("run.") || it.text("type").startsWith("interaction.") || it.text("type").startsWith("approval.") || it.text("type").startsWith("session.follow_up") || it.text("type") == "session.native_history_synced" || it.text("type") == "session.title_changed" }) {
                        projection.history(peer.call(host, "session.history", json("sessionId" to session.id)))
                        refreshSession(host, session.id)
                        publish()
                    }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                if (generation == sessionGeneration) {
                    if (error is RemoteFailure && error.code == "CURSOR_RESET_REQUIRED") projection = SessionProjection()
                    mutable.update { it.copy(error = readableError(error), busy = false) }
                    if (foreground) connectionWake.trySend(Unit)
                }
                // The connection loop hydrates a fresh cursor and restarts this reader.
            }
        }
    }
    private suspend fun refreshSession(host: Host, id: String) {
        val generation = sessionGeneration
        val params = json("sessionId" to id)
        val snapshot = if ("session.snapshot" in state.value.capabilities) peer.call(host, "session.snapshot", params) else coroutineScope {
            // Older desktops remain compatible; independent reads share one network wait.
            val detail = async { peer.call(host, "session.details", params) }
            val runs = async { peer.call(host, "run.list", params).objects("items") }
            val interactions = async { peer.call(host, "interaction.list", params).objects("items") }
            val approvals = async { peer.call(host, "approval.list", params).objects("items") }
            json("details" to detail.await(), "runs" to JSONArray(runs.await()), "interactions" to JSONArray(interactions.await()), "approvals" to JSONArray(approvals.await()))
        }
        val detail = snapshot.getJSONObject("details")
        val config = detail.getJSONObject("session")
        val runs = snapshot.objects("runs")
        val latest = runs.maxByOrNull { it.text("startedAt", it.text("createdAt")) }
        val questions = snapshot.objects("interactions")
        val approvals = snapshot.objects("approvals")
        if (generation != sessionGeneration || state.value.session?.id != id || state.value.host?.id != host.id) return
        latest?.let {
            projection.runId = it.text("id"); projection.runStatus = it.text("status")
            projection.startedAt = it.text("startedAt"); projection.endedAt = it.text("endedAt")
        }
        mutable.update { it.copy(sessions = it.sessions.map { item -> if (item.id == id) item.copy(title = config.text("title", item.title)) else item }, session = it.session?.copy(title = config.text("title", it.session.title), model = config.text("model"), effort = config.text("reasoningEffort"),
            provider = detail.optJSONObject("agent")?.text("name").orEmpty(), agentId = detail.optJSONObject("agent")?.text("id").orEmpty(), connectionId = config.text("connectionId"),
            permissionMode = config.text("permissionMode"), agentMode = config.text("agentMode"), modeLocked = config.optBoolean("modeLocked")), members = detail.objects("members"), interactions = mergeInteractions(it.interactions, projection.interactionList(), questions), approvals = approvals, runs = runs.map(RunInfo::decode), busy = false) }
    }
    private fun publish() {
        val seconds = runCatching {
            val end = projection.endedAt.takeIf(String::isNotEmpty)?.let(Instant::parse) ?: Instant.now()
            java.time.Duration.between(Instant.parse(projection.startedAt), end).seconds.coerceAtLeast(0)
        }.getOrDefault(0)
        val currentRun = RunInfo(projection.runId, projection.runStatus, projection.startedAt, projection.endedAt)
        mutable.update { it.copy(messages = projection.messageList(), activities = projection.activityList(), hasOlder = projection.before != null,
            interactions = mergeInteractions(it.interactions, projection.interactionList()),
            runId = projection.runId, runStatus = projection.runStatus, runError = projection.runError, elapsed = seconds,
            runs = if (currentRun.id.isBlank()) it.runs else it.runs.filterNot { run -> run.id == currentRun.id } + currentRun, busy = false) }
    }
    fun older() = action { host, session ->
        val before = projection.before ?: return@action
        projection.history(peer.call(host, "session.history", json("sessionId" to session.id, "before" to before)), older = true)
        publish()
    }
    fun send(mode: String? = null, sourceDraftKey: String? = null): Boolean {
        val s = state.value
        val host = s.host ?: return false
        val session = s.session ?: return false
        if (s.readOnly || s.attachmentLoading || (s.draft.isBlank() && s.draftAttachments.isEmpty())) return false
        if (mode != null && s.draftAttachments.isNotEmpty()) { mutable.update { it.copy(error = "附件将在当前轮结束后发送，请稍后再试") }; return false }
        val method = if (mode != null) "session.followUp" else "session.send"
        val params = json("sessionId" to session.id, "text" to s.draft.trim())
        if (s.draftAttachments.isNotEmpty()) {
            params.put("attachmentIds", JSONArray(s.draftAttachments.map { it.id }))
            params.put("_attachments", JSONArray(s.draftAttachments.map { it.encode() }))
        }
        if (mode != null) params.put("mode", mode)
        val command = PendingCommand(UUID.randomUUID().toString(), host.id, session.id, method, params, Instant.now().toString())
        try { store.enqueueMessage(command, listOfNotNull("${host.id}:${session.id}", sourceDraftKey)) } catch (error: Exception) { mutable.update { it.copy(error = "手机无法保存待发送消息，请检查存储空间") }; return false }
        draftJob?.cancel()
        mutable.update { it.copy(draft = "", draftAttachments = emptyList()) }
        viewModelScope.launch {
            projection.optimistic(ChatMessage(PendingCommand.stableMessageId(peer.identity(), command.id), "user", command.params.text("text").ifBlank { "请查看附件。" }, command.createdAt, "sending", attachmentNames = s.draftAttachments.map { it.name }, attachments = s.draftAttachments.map(ChatAttachment::draft)))
            publish()
            try { flushOutbox(host) } catch (error: Exception) { mutable.update { it.copy(error = readableError(error)) } }
        }
        return true
    }
    private suspend fun uploadAttachment(host: Host, attachment: DraftAttachment) = withContext(Dispatchers.IO) {
        val file = attachmentFiles.file(attachment)
        val input = attachment.encode().apply { remove("id"); remove("path"); put("uploadId", attachment.id); put("offset", 0); put("data", "") }
        var received = peer.call(host, "attachment.upload", input).getLong("receivedBytes")
        require(received in 0..attachment.sizeBytes) { "附件上传进度无效，请重新选择" }
        java.io.RandomAccessFile(file, "r").use { stream ->
            val buffer = ByteArray(128 * 1024)
            while (received < attachment.sizeBytes) {
                stream.seek(received)
                val count = stream.read(buffer)
                require(count > 0) { "附件已不可用，请重新选择" }
                input.put("offset", received).put("data", Base64.getEncoder().encodeToString(buffer.copyOf(count)))
                val next = peer.call(host, "attachment.upload", input).getLong("receivedBytes")
                require(next == received + count) { "附件上传进度无效，请重试" }
                received = next
                // Leave room for history/events within the desktop's 100/10s
                // request budget, including on a very fast local connection.
                if (received < attachment.sizeBytes) delay(125)
            }
        }
    }
    private suspend fun flushOutbox(host: Host) {
        if (!commandLock.tryLock()) return
        try {
            for (command in store.commands().filter { it.hostId == host.id }) {
                val messageId = PendingCommand.stableMessageId(peer.identity(), command.id)
                val files = command.params.objects("_attachments").map(DraftAttachment::decode)
                try {
                    for (file in files) attachmentImages.retain(host.id, command.sessionId, file)
                    for (file in files) uploadAttachment(host, file)
                    val input = JSONObject(command.params.toString()).apply { remove("_attachments") }
                    peer.call(host, command.method, input, command.id)
                    store.finishCommand(command.id)
                    files.forEach(attachmentFiles::remove)
                    if (state.value.session?.id == command.sessionId) { projection.delivery(messageId, "sent"); publish() }
                } catch (error: RemoteFailure) {
                    val uploadRetry = files.isNotEmpty() && error.code in listOf("ATTACHMENT_INCOMPLETE", "ATTACHMENT_NOT_AVAILABLE", "ATTACHMENT_STORAGE_FULL", "METHOD_NOT_ALLOWED")
                    val transportRetry = error.isTransportFailure()
                    val uncertain = transportRetry || uploadRetry || error.code in listOf("COMMAND_OUTCOME_PENDING", "DEVICE_NOT_AUTHORIZED", "REMOTE_DISABLED")
                    if (!uncertain) store.finishCommand(command.id)
                    if (state.value.session?.id == command.sessionId) { projection.delivery(messageId, if (transportRetry || uploadRetry) "waiting" else if (uncertain) "review" else "failed"); publish() }
                    mutable.update { it.copy(error = readableError(error)) }
                    // Preserve the original ID. The user can retry this exact command after reviewing.
                    if (uncertain) break
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    if (state.value.session?.id == command.sessionId) { projection.delivery(messageId, "waiting"); publish() }
                    throw error
                }
            }
        } finally { commandLock.unlock() }
    }
    fun retryMessages() = action { host, _ -> flushOutbox(host) }
    fun cancelRun() = action { host, _ -> peer.call(host, "run.cancel", json("runId" to state.value.runId)) }
    fun newSession(template: Conversation) = actionForHost { host ->
        val created = peer.call(host, "session.create", json("sessionId" to template.id))
        refreshProjects(host)
        openSession(Conversation.decode(created))
    }
    fun loadSetup() = actionForHost { host ->
        mutable.update { it.copy(setupLoading = true) }
        try {
            val options = peer.call(host, "session.options")
            mutable.update { it.copy(setup = options) }
        } finally { mutable.update { it.copy(setupLoading = false) } }
    }
    private var catalogJob: Job? = null
    private var catalogGeneration = 0
    private val catalogCache = linkedMapOf<String, List<JSONObject>>()
    fun loadNewModels(agentId: String, connectionId: String, refresh: Boolean = false) {
        catalogJob?.cancel()
        val generation = ++catalogGeneration
        val host = state.value.host ?: return
        val key = "${host.id}:$agentId:$connectionId"
        if (!refresh) catalogCache[key]?.let { values ->
            mutable.update { it.copy(catalogLoading = false, newModels = values) }; return
        }
        catalogJob = viewModelScope.launch {
            mutable.update { it.copy(catalogLoading = true, newModels = emptyList()) }
            try {
                val catalog = peer.call(host, "session.catalog", json("agentInstanceId" to agentId, "connectionId" to connectionId))
                if (generation == catalogGeneration && state.value.host?.id == host.id) {
                    val values = catalog.objects("models")
                    if (values.isNotEmpty()) { catalogCache[key] = values; if (catalogCache.size > 20) catalogCache.remove(catalogCache.keys.first()) }
                    mutable.update { it.copy(newModels = values) }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (generation == catalogGeneration) mutable.update { it.copy(error = readableError(error)) } }
            finally { if (generation == catalogGeneration) mutable.update { it.copy(catalogLoading = false) } }
        }
    }
    fun createSession(projectId: String, agentId: String, connectionId: String, selectedModel: String, effort: String, firstMessage: String = "", permissionMode: String = "", agentMode: String = "", onCreated: () -> Unit = {}) = actionForHost { host ->
        if (state.value.changing) return@actionForHost
        mutable.update { it.copy(changing = true) }
        val firstAttachments = state.value.newAttachments
        try {
            val input = json("projectId" to projectId, "agentInstanceId" to agentId, "title" to "新会话")
            if (connectionId.isNotEmpty()) input.put("connectionId", connectionId)
            if (selectedModel.isNotEmpty()) input.put("model", selectedModel)
            if (effort.isNotEmpty()) input.put("reasoningEffort", effort)
            if (permissionMode.isNotEmpty()) input.put("permissionMode", permissionMode)
            if (agentMode.isNotEmpty()) input.put("agentMode", agentMode)
            val created = peer.call(host, "session.create", input)
            val conversation = Conversation.decode(created)
            mutable.update { it.copy(sessions = listOf(conversation) + it.sessions.filterNot { item -> item.id == conversation.id }) }
            openSession(conversation)
            if (firstMessage.isNotBlank() || firstAttachments.isNotEmpty()) {
                store.attachments("${host.id}:${conversation.id}", firstAttachments)
                mutable.update { it.copy(draftAttachments = firstAttachments) }
                draft(firstMessage)
                if (send(sourceDraftKey = "new:${host.id}")) {
                    mutable.update { it.copy(newDraft = "", newAttachments = emptyList()) }
                }
            }
            onCreated()
        } finally { mutable.update { it.copy(changing = false) } }
    }
    fun browse(path: String = "", offset: Int = 0) = actionForHost { host ->
        mutable.update { it.copy(directoryLoading = true) }
        try {
            val directory = peer.call(host, "project.browse", json("path" to path, "offset" to offset))
            if (offset > 0) directory.put("directories", org.json.JSONArray(state.value.directory.objects("directories") + directory.objects("directories")))
            mutable.update { it.copy(directory = directory) }
        } finally { mutable.update { it.copy(directoryLoading = false) } }
    }
    fun createProject(name: String, rootPath: String, folderName: String = "", created: (Project) -> Unit = {}) = actionForHost { host ->
        mutable.update { it.copy(changing = true) }
        try {
            val result = peer.call(host, "project.create", json("name" to name, "rootPath" to rootPath, "folderName" to folderName))
            refreshProjects(host)
            created(Project(result.text("id"), result.text("name"), result.text("rootPath")))
        } finally { mutable.update { it.copy(changing = false) } }
    }
    fun loadModels(refresh: Boolean = false) = action { host, session ->
        if (state.value.modelsLoading || (!refresh && state.value.models.isNotEmpty())) return@action
        val generation = sessionGeneration
        mutable.update { it.copy(modelsLoading = true) }
        try {
            val models = peer.call(host, "session.models", json("sessionId" to session.id)).objects("models")
            if (generation == sessionGeneration) mutable.update { it.copy(models = models) }
        } finally { if (generation == sessionGeneration) mutable.update { it.copy(modelsLoading = false) } }
    }
    private var modesJob: Job? = null
    fun loadModes(agentId: String, projectId: String, refresh: Boolean = false) {
        val host = state.value.host ?: return
        if (agentId.isBlank() || "session.modes" !in state.value.capabilities) return
        val key = "${host.id}:$agentId:$projectId"
        if (!refresh && state.value.modesKey == key && (state.value.modesLoading || state.value.modes.length() > 0)) return
        modesJob?.cancel()
        mutable.update { it.copy(modesKey = key, modes = JSONObject(), modesLoading = true) }
        modesJob = viewModelScope.launch {
            try {
                val catalog = peer.call(host, "session.modes", json("agentInstanceId" to agentId, "projectId" to projectId.takeIf(String::isNotEmpty)))
                if (state.value.modesKey == key) mutable.update { it.copy(modes = catalog) }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (state.value.modesKey == key) mutable.update { it.copy(error = readableError(error)) } }
            finally { if (state.value.modesKey == key) mutable.update { it.copy(modesLoading = false) } }
        }
    }
    fun configureModes(permissionMode: String, agentMode: String, configured: () -> Unit) = action { host, session ->
        if (state.value.changing) return@action
        mutable.update { it.copy(changing = true, error = "") }
        try {
            val input = json("sessionId" to session.id)
            if (permissionMode.isNotEmpty() && permissionMode != session.permissionMode) input.put("permissionMode", permissionMode)
            if (agentMode.isNotEmpty() && agentMode != session.agentMode) input.put("agentMode", agentMode)
            if (input.length() > 1) peer.call(host, "session.configure", input)
            if (state.value.session?.id == session.id && state.value.host?.id == host.id) {
                mutable.update { it.copy(session = it.session?.copy(permissionMode = permissionMode, agentMode = agentMode)) }
                configured()
            }
        } finally { mutable.update { it.copy(changing = false) } }
    }
    fun configure(model: String, effort: String, connectionId: String? = null, confirmChange: Boolean = false, configured: () -> Unit = {}) = action { host, session ->
        if (state.value.changing) return@action
        mutable.update { it.copy(changing = true, error = "") }
        try {
            val input = json("sessionId" to session.id, "model" to model, "reasoningEffort" to effort)
            if (connectionId != null) input.put("connectionId", connectionId).put("confirmConnectionChange", confirmChange)
            peer.call(host, "session.configure", input)
            if (state.value.session?.id == session.id && state.value.host?.id == host.id) {
                mutable.update { it.copy(session = it.session?.copy(model = model, effort = effort, connectionId = connectionId ?: session.connectionId),
                    models = if (connectionId != null && connectionId != session.connectionId) it.newModels else it.models) }
                configured()
                viewModelScope.launch {
                    try { refreshSession(host, session.id) } catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { /* The live event reader refreshes again. */ }
                }
            }
        } finally { mutable.update { it.copy(changing = false) } }
    }
    fun workspace() {
        navigate(Screen.Workspace)
        action { host, session ->
            mutable.update { it.copy(workspaceLoading = true) }
            try {
                val files = peer.call(host, "session.workspace", json("sessionId" to session.id)).objects("files")
                mutable.update { it.copy(workspace = files) }
            }
            finally { mutable.update { it.copy(workspaceLoading = false) } }
        }
    }
    fun openDiff(path: String) { mutable.update { it.copy(diffPath = path, screen = Screen.FileDiff) } }
    fun approve(id: String, decision: String, scope: String = "once", finished: () -> Unit = {}) {
        if (state.value.host == null || state.value.session == null) { finished(); return }
        action { host, session ->
            try {
                peer.call(host, "approval.resolve", json("sessionId" to session.id, "approvalId" to id, "decision" to decision, "scope" to scope))
                refreshSession(host, session.id)
            } finally { finished() }
        }
    }
    fun answer(id: String, answers: JSONObject, optionId: String? = null, cancelled: Boolean = false, finished: () -> Unit = {}) {
      if (state.value.host == null || state.value.session == null) { finished(); return }
      action { host, session ->
        val params = json("sessionId" to session.id, "interactionId" to id, "outcome" to if (cancelled) "cancelled" else "selected", "answers" to answers)
        if (optionId != null) params.put("optionId", optionId)
        try {
            peer.call(host, "interaction.respond", params)
            refreshSession(host, session.id)
        } finally { finished() }
      }
    }
    private fun action(block: suspend (Host, Conversation) -> Unit) = actionForHost { host ->
        state.value.session?.let { block(host, it) }
    }
    private fun actionForHost(block: suspend (Host) -> Unit) {
        val host = state.value.host ?: return
        viewModelScope.launch {
            try { block(host) } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { mutable.update { it.copy(error = readableError(error)) } }
        }
    }
    override fun onCleared() { saveDraft(); super.onCleared() }
}
