package app.nautilo.mobile

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.nautilo.mobile.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import org.json.JSONObject
import java.time.Instant
import java.util.UUID
import kotlin.random.Random

enum class Screen { Projects, NewConversation, Chat, Workspace, FileDiff, Computers }
data class MobileState(
    val screen: Screen = Screen.Projects,
    val hosts: List<Host> = emptyList(), val host: Host? = null,
    val connected: Boolean = false, val connecting: Boolean = false,
    val path: String = "", val latency: Long? = null, val system: String = "",
    val error: String = "", val pairingCode: String = "", val pairing: Boolean = false,
    val projects: List<Project> = emptyList(), val sessions: List<Conversation> = emptyList(),
    val session: Conversation? = null, val messages: List<ChatMessage> = emptyList(),
    val activities: List<ActivityItem> = emptyList(), val busy: Boolean = false,
    val runId: String = "", val runStatus: String = "", val elapsed: Long = 0,
    val runError: String = "",
    val runs: List<RunInfo> = emptyList(),
    val draft: String = "", val newDraft: String = "", val readOnly: Boolean = false, val hasOlder: Boolean = false,
    val models: List<JSONObject> = emptyList(), val modelsLoading: Boolean = false,
    val workspace: List<JSONObject> = emptyList(), val workspaceLoading: Boolean = false,
    val diffPath: String = "",
    val members: List<JSONObject> = emptyList(), val interactions: List<JSONObject> = emptyList(),
    val approvals: List<JSONObject> = emptyList(), val changing: Boolean = false,
    val setup: JSONObject = JSONObject(), val setupLoading: Boolean = false,
    val newModels: List<JSONObject> = emptyList(), val catalogLoading: Boolean = false,
    val directory: JSONObject = JSONObject(), val directoryLoading: Boolean = false
)

class MobileViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as NautiloApplication
    private val store = app.store
    private val peer = app.peer
    private val mutable = MutableStateFlow(MobileState(hosts = store.hosts(), host = store.selectedHost()))
    val state = mutable.asStateFlow()
    private var connectionJob: Job? = null
    private var sessionJob: Job? = null
    private var projection = SessionProjection()
    private var foreground = false
    private var sessionGeneration = 0
    private var connectionGeneration = 0
    private val commandLock = kotlinx.coroutines.sync.Mutex()
    private var draftJob: Job? = null

    fun foreground(active: Boolean) {
        if (foreground == active) return
        foreground = active
        if (active) {
            val pending = store.pendingHost()
            if (pending != null) resumePairing(pending) else startConnection()
        } else {
            connectionJob?.cancel(); sessionJob?.cancel()
            mutable.update { it.copy(connected = false, connecting = false) }
            viewModelScope.launch { peer.disconnect() }
        }
    }
    fun navigate(screen: Screen) { mutable.update { it.copy(screen = screen) } }
    fun clearError() { mutable.update { it.copy(error = "") } }
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
    fun beginConversation() {
        saveDraft()
        mutable.update { it.copy(screen = Screen.NewConversation, newDraft = store.draft("new:${it.host?.id}"), error = "") }
        loadSetup()
    }
    fun newDraft(text: String) {
        mutable.update { it.copy(newDraft = text) }
        draftJob?.cancel()
        draftJob = viewModelScope.launch { delay(500); saveDraft() }
    }
    fun selectHost(host: Host) {
        saveDraft()
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
        connectionJob?.cancel()
        val generation = ++connectionGeneration
        connectionJob = viewModelScope.launch {
            var failures = 0
            while (isActive && foreground && generation == connectionGeneration) {
                try {
                    mutable.update { it.copy(connecting = !it.connected) }
                    val hello = peer.call(host, "hello")
                    if (generation != connectionGeneration) return@launch
                    mutable.update { it.copy(connected = true, connecting = false, error = "", system = hello.text("system"),
                        readOnly = false, path = peer.path(), latency = peer.latency()) }
                    refreshProjects(host)
                    if (sessionJob?.isActive != true && state.value.session != null) watchSession(state.value.session!!)
                    flushOutbox(host)
                    failures = 0
                    delay(20_000)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    mutable.update { it.copy(connected = false, connecting = false, error = readableError(error)) }
                    if (error is RemoteFailure && error.code == "DEVICE_NOT_AUTHORIZED") break
                    delay((1000L shl failures.coerceAtMost(4)) + Random.nextLong(500))
                    failures++
                }
            }
        }
    }
    private suspend fun refreshProjects(host: Host) {
        val projects = peer.call(host, "projects.list").objects("projects").map { Project(it.getString("id"), it.text("name"), it.text("rootPath")) }
        val sessions = mutableListOf<Conversation>()
        for (project in projects) {
            var offset: Int? = 0
            while (offset != null && offset < 10_000) {
                val page = peer.call(host, "sessions.list", json("projectId" to project.id, "offset" to offset, "limit" to 200))
                sessions += page.objects("sessions").map(Conversation::decode)
                offset = if (page.isNull("nextOffset")) null else page.optInt("nextOffset")
            }
        }
        if (state.value.host?.id == host.id) mutable.update { it.copy(projects = projects, sessions = sessions.sortedByDescending(Conversation::updatedAt)) }
    }
    fun openSession(session: Conversation) {
        saveDraft()
        sessionGeneration++; sessionJob?.cancel()
        projection = SessionProjection()
        val host = state.value.host ?: return
        mutable.update { it.copy(session = session, screen = Screen.Chat, messages = emptyList(), activities = emptyList(), busy = true,
            models = emptyList(), workspace = emptyList(), interactions = emptyList(), approvals = emptyList(), runs = emptyList(), runId = "", runStatus = "", error = "",
            draft = store.draft("${host.id}:${session.id}")) }
        watchSession(session)
    }
    private fun watchSession(session: Conversation) {
        val host = state.value.host ?: return
        val generation = sessionGeneration
        sessionJob?.cancel()
        sessionJob = viewModelScope.launch {
            try {
                val page = peer.call(host, "session.history", json("sessionId" to session.id))
                if (generation != sessionGeneration) return@launch
                projection.history(page, initialize = true)
                for (command in store.commands().filter { it.hostId == host.id && it.sessionId == session.id }) {
                    val id = PendingCommand.stableMessageId(peer.identity(), command.id)
                    projection.optimistic(ChatMessage(id, "user", command.params.text("text"), command.createdAt, "waiting"))
                }
                refreshSession(host, session.id)
                publish()
                while (isActive && foreground && generation == sessionGeneration) {
                    val events = peer.call(host, "events.wait", json("sessionId" to session.id, "epoch" to projection.epoch, "afterSequence" to projection.sequence))
                    if (generation != sessionGeneration) return@launch
                    val changes = events.objects("events")
                    changes.forEach { projection.apply(it) }
                    publish()
                    if (changes.any { it.text("type").startsWith("run.") || it.text("type").startsWith("interaction.") || it.text("type").startsWith("approval.") || it.text("type").startsWith("session.follow_up") || it.text("type") == "session.native_history_synced" }) {
                        projection.history(peer.call(host, "session.history", json("sessionId" to session.id)))
                        refreshSession(host, session.id)
                        publish()
                    }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                if (generation == sessionGeneration) mutable.update { it.copy(error = readableError(error), busy = false) }
                // The connection loop hydrates a fresh cursor and restarts this reader.
            }
        }
    }
    private suspend fun refreshSession(host: Host, id: String) {
        val detail = peer.call(host, "session.details", json("sessionId" to id))
        val config = detail.getJSONObject("session")
        val runs = peer.call(host, "run.list", json("sessionId" to id)).objects("items")
        val latest = runs.maxByOrNull { it.text("startedAt", it.text("createdAt")) }
        latest?.let {
            projection.runId = it.text("id"); projection.runStatus = it.text("status")
            projection.startedAt = it.text("startedAt"); projection.endedAt = it.text("endedAt")
        }
        val questions = peer.call(host, "interaction.list", json("sessionId" to id)).objects("items")
        val approvals = peer.call(host, "approval.list", json("sessionId" to id)).objects("items")
        if (state.value.session?.id != id || state.value.host?.id != host.id) return
        mutable.update { it.copy(session = it.session?.copy(title = config.text("title", it.session.title), model = config.text("model"), effort = config.text("reasoningEffort"),
            provider = detail.optJSONObject("agent")?.text("name").orEmpty(), agentId = detail.optJSONObject("agent")?.text("id").orEmpty(), connectionId = config.text("connectionId")), members = detail.objects("members"), interactions = questions, approvals = approvals, runs = runs.map(RunInfo::decode), busy = false) }
    }
    private fun publish() {
        val seconds = runCatching {
            val end = projection.endedAt.takeIf(String::isNotEmpty)?.let(Instant::parse) ?: Instant.now()
            java.time.Duration.between(Instant.parse(projection.startedAt), end).seconds.coerceAtLeast(0)
        }.getOrDefault(0)
        val currentRun = RunInfo(projection.runId, projection.runStatus, projection.startedAt, projection.endedAt)
        mutable.update { it.copy(messages = projection.messageList(), activities = projection.activityList(), hasOlder = projection.before != null,
            runId = projection.runId, runStatus = projection.runStatus, runError = projection.runError, elapsed = seconds,
            runs = if (currentRun.id.isBlank()) it.runs else it.runs.filterNot { run -> run.id == currentRun.id } + currentRun, busy = false) }
    }
    fun older() = action { host, session ->
        val before = projection.before ?: return@action
        projection.history(peer.call(host, "session.history", json("sessionId" to session.id, "before" to before)), older = true)
        publish()
    }
    fun send(mode: String? = null) {
        val s = state.value
        val host = s.host ?: return
        val session = s.session ?: return
        if (s.readOnly || s.draft.isBlank()) return
        val method = if (mode != null) "session.followUp" else "session.send"
        val params = json("sessionId" to session.id, "text" to s.draft.trim())
        if (mode != null) params.put("mode", mode)
        val command = PendingCommand(UUID.randomUUID().toString(), host.id, session.id, method, params, Instant.now().toString())
        try { store.putCommand(command) } catch (error: Exception) { mutable.update { it.copy(error = "手机无法保存待发送消息，请检查存储空间") }; return }
        mutable.update { it.copy(draft = "") }; store.draft("${host.id}:${session.id}", "")
        viewModelScope.launch {
            projection.optimistic(ChatMessage(PendingCommand.stableMessageId(peer.identity(), command.id), "user", command.params.text("text"), command.createdAt, "sending"))
            publish()
            try { flushOutbox(host) } catch (error: Exception) { mutable.update { it.copy(error = readableError(error)) } }
        }
    }
    private suspend fun flushOutbox(host: Host) {
        if (!commandLock.tryLock()) return
        try {
            for (command in store.commands().filter { it.hostId == host.id }) {
                val messageId = PendingCommand.stableMessageId(peer.identity(), command.id)
                try {
                    peer.call(host, command.method, command.params, command.id)
                    store.finishCommand(command.id)
                    if (state.value.session?.id == command.sessionId) { projection.delivery(messageId, "sent"); publish() }
                } catch (error: RemoteFailure) {
                    val uncertain = error.code in listOf("COMMAND_OUTCOME_PENDING", "DEVICE_NOT_AUTHORIZED", "REMOTE_DISABLED")
                    if (!uncertain) store.finishCommand(command.id)
                    if (state.value.session?.id == command.sessionId) { projection.delivery(messageId, if (uncertain) "review" else "failed"); publish() }
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
    fun createSession(projectId: String, agentId: String, connectionId: String, selectedModel: String, effort: String, firstMessage: String = "", onCreated: () -> Unit = {}) = actionForHost { host ->
        if (state.value.changing) return@actionForHost
        mutable.update { it.copy(changing = true) }
        try {
            val input = json("projectId" to projectId, "agentInstanceId" to agentId, "title" to "新会话")
            if (connectionId.isNotEmpty()) input.put("connectionId", connectionId)
            if (selectedModel.isNotEmpty()) input.put("model", selectedModel)
            if (effort.isNotEmpty()) input.put("reasoningEffort", effort)
            val created = peer.call(host, "session.create", input)
            val conversation = Conversation.decode(created)
            mutable.update { it.copy(sessions = listOf(conversation) + it.sessions.filterNot { item -> item.id == conversation.id }) }
            openSession(conversation)
            if (firstMessage.isNotBlank()) {
                draft(firstMessage)
                send()
                mutable.update { it.copy(newDraft = "") }
                store.draft("new:${host.id}", "")
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
        if (!refresh && state.value.models.isNotEmpty()) return@action
        mutable.update { it.copy(modelsLoading = true) }
        try {
            val models = peer.call(host, "session.models", json("sessionId" to session.id)).objects("models")
            mutable.update { it.copy(models = models) }
        } finally { mutable.update { it.copy(modelsLoading = false) } }
    }
    fun configure(model: String, effort: String, connectionId: String? = null, confirmChange: Boolean = false, configured: () -> Unit = {}) = action { host, session ->
        if (state.value.changing) return@action
        mutable.update { it.copy(changing = true) }
        try {
            val input = json("sessionId" to session.id, "model" to model, "reasoningEffort" to effort)
            if (connectionId != null) input.put("connectionId", connectionId).put("confirmConnectionChange", confirmChange)
            peer.call(host, "session.configure", input)
            if (connectionId != null && connectionId != session.connectionId) mutable.update { it.copy(models = it.newModels) }
            refreshSession(host, session.id)
            configured()
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
    fun approve(id: String, decision: String) = action { host, session ->
        peer.call(host, "approval.resolve", json("sessionId" to session.id, "approvalId" to id, "decision" to decision))
        refreshSession(host, session.id)
    }
    fun answer(id: String, answers: JSONObject, optionId: String? = null) = action { host, session ->
        val params = json("sessionId" to session.id, "interactionId" to id, "outcome" to "selected", "answers" to answers)
        if (optionId != null) params.put("optionId", optionId)
        peer.call(host, "interaction.respond", params)
        refreshSession(host, session.id)
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
