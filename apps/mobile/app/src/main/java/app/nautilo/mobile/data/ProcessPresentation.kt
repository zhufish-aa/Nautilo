package app.nautilo.mobile.data

import org.json.JSONArray
import org.json.JSONObject

// Ported from desktop lib/tool-display.ts and lib/process-display.ts.
// Desktop-generated fixtures verify labels, previews, receipts and call ancestry.
private val pathKeys = listOf("path", "file_path", "filePath", "filepath", "target_path", "targetPath", "target_file", "targetFile", "filename", "file")
private val queryKeys = listOf("query", "pattern", "regex", "q", "search", "needle")
private val globKeys = listOf("glob", "pattern", "file_pattern", "filePattern", "include")
private val commandKeys = listOf("command", "cmd", "command_line")
private fun JSONObject.firstString(keys: List<String>) = keys.firstNotNullOfOrNull { key -> (opt(key) as? String) }
private fun JSONObject.firstText(keys: List<String>) = keys.firstNotNullOfOrNull { key -> (opt(key) as? String)?.trim()?.takeIf(String::isNotEmpty) }

private fun decodeFragment(value: String): String = buildString {
    var index = 0
    while (index < value.length) {
        val c = value[index++]
        if (c != '\\') { append(c); continue }
        if (index == value.length) break
        when (val escape = value[index++]) {
            'n' -> append('\n'); 'r' -> append('\r'); 't' -> append('\t'); 'b' -> append('\b'); 'f' -> append('\u000c')
            'u' -> {
                val code = value.substring(index, (index + 4).coerceAtMost(value.length))
                if (!code.matches(Regex("[0-9a-fA-F]{4}"))) break
                append(code.toInt(16).toChar()); index += 4
            }
            else -> append(escape)
        }
    }
}
private fun partialString(input: String, key: String, truncated: Boolean = false): Pair<String, Boolean>? {
    Regex("\"${Regex.escape(key)}\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"").find(input)?.let { return decodeFragment(it.groupValues[1]) to false }
    if (!truncated) return null
    val prefix = Regex("\"${Regex.escape(key)}\"\\s*:\\s*\"").find(input) ?: return null
    return decodeFragment(input.substring(prefix.range.last + 1)) to true
}
internal fun parseToolInput(input: String): JSONObject {
    runCatching { JSONObject(input) }.getOrNull()?.let { root -> return root.optJSONObject("arguments") ?: root.optJSONObject("input") ?: root }
    val partial = JSONObject()
    (pathKeys + queryKeys + globKeys).forEach { key -> partialString(input, key)?.let { partial.put(key, it.first) } }
    for (key in listOf("content", "text", "data")) {
        val text = partialString(input, key, true) ?: continue
        partial.put(key, text.first)
        if (text.second) partial.put("__truncated", true)
        break
    }
    return partial
}
private fun normalized(name: String) = name.trim().replace(Regex("([a-z0-9])([A-Z])"), "$1_$2").lowercase().replace(Regex("[^a-z0-9]+"), "_")
private val mcpName = Regex("""^(?:functions\.)?(?:mcp(?:__|\.)(.+?)(?:__|[./:])(.+)|([\w.-]+)/([\w.-]+))$""")
private val browserName = Regex("""(?:^|[_.:/-])browser_(run|eval|assert|wait|read|tabs|state|screenshot|scroll|session|files|dialog|cdp|fetch|paste|events)(?:$|_for_control$)""", RegexOption.IGNORE_CASE)
private fun mcpCall(name: String, input: String): Pair<String, String>? {
    mcpName.matchEntire(name)?.groupValues?.let { return it[1].ifEmpty { it[3] } to it[2].ifEmpty { it[4] } }
    if (!normalized(name).startsWith("mcp")) return null
    val payload = runCatching { JSONObject(input) }.getOrNull() ?: return null
    val server = payload.firstText(listOf("serverName", "server", "server_name")) ?: return null
    return server to (payload.firstText(listOf("toolName", "tool", "tool_name")) ?: name)
}

internal fun toolFilePath(input: String) = parseToolInput(input).firstText(pathKeys)
internal fun toolCommand(input: String) = parseToolInput(input).firstText(commandKeys)
private fun nativeFileKind(name: String): String? {
    val n = normalized(name)
    return when {
        n == "read" || n.startsWith("read_") || n.startsWith("reading_") || n.endsWith("_read") || n.endsWith("_read_file") -> "read"
        n == "write" || n.startsWith("write_") || n.startsWith("writing_") || n.endsWith("_write") || n.endsWith("_write_file") -> "write"
        n == "edit" || n.startsWith("edit_") || n.startsWith("editing_") || n.endsWith("_edit") || n.endsWith("_edit_file") -> "edit"
        n == "grep" || n.startsWith("grep_") || n.startsWith("searching_") || n.endsWith("_grep") -> "grep"
        n == "glob" || n.startsWith("glob_") || n.startsWith("finding_") || n.endsWith("_glob") -> "glob"
        else -> null
    }
}
internal fun toolActivityKind(name: String, input: String = ""): String {
    val n = normalized(name)
    val parsed = parseToolInput(input)
    val kind = nativeFileKind(name)
    fun matches(pattern: String) = Regex("(?:^|_)(?:$pattern)(?:_|$)").containsMatchIn(n)
    return when {
        matches("ask_user_question|askuserquestion|request_user_input") -> "question"
        matches("load_skill|read_skill|use_skill|skill|skills") || kind == "read" && Regex("(?:^|[\\\\/])SKILL\\.md$", RegexOption.IGNORE_CASE).containsMatchIn(parsed.firstText(pathKeys).orEmpty()) ||
            Regex("(?:Get-Content|\\bcat\\b|\\btype\\b|\\bsed\\b|\\bhead\\b).*\\bSKILL\\.md\\b", RegexOption.IGNORE_CASE).containsMatchIn(parsed.firstText(listOf("command", "cmd", "command_line")).orEmpty()) -> "skill"
        matches("mcp") || n.startsWith("codex_apps_") || mcpName.matches(name) -> "mcp"
        matches("bash|pwsh|shell|shell_command|exec_command|run_command|execute_command|terminal|write_stdin") -> "command"
        matches("read_image|view_image|image_gen|imagegen") -> "image"
        matches("run_code|execute_code|python|node_repl") -> "code"
        matches("web|web_search|web_fetch|fetch_url|browse") -> "web"
        kind in listOf("grep", "glob") -> "search"
        kind != null -> kind
        matches("str_replace|apply_patch|replace_in_file|edit_file") -> "edit"
        matches("view_files|view_file|read_file|read_text_file|open_file") -> "read"
        matches("create_file|write_file") -> "write"
        matches("delete_file|remove_file") -> "delete"
        matches("search|find|list_directory|list_dir|ls") -> "search"
        else -> "tool"
    }
}
internal fun toolActivityLabel(name: String, status: String, input: String = "", omitFilePath: Boolean = false): String {
    val index = if (status == "running") 0 else if (status == "done") 1 else 2
    val activity = toolActivityKind(name, input)
    if (activity == "question") return listOf("等待你的回答", "已提问", "提问未完成")[index]
    mcpCall(name, input)?.let { (server, tool) -> return "${listOf("正在调用", "调用了", "调用失败")[index]} $server · $tool" }
    val parsed = parseToolInput(input)
    if (activity == "web") {
        val query = parsed.firstText(queryKeys + "url") ?: input.trim().takeUnless { it.startsWith("{") || it.startsWith("[") }.orEmpty()
        return listOf(listOf("正在搜索网页", "搜索网页", "网页搜索失败")[index], query).filter(String::isNotBlank).joinToString(" · ")
    }
    val kind = nativeFileKind(name) ?: when (activity) {
        "read", "write", "edit", "delete" -> activity
        "search" -> "grep"
        else -> return "${listOf("正在使用", "已使用", "调用失败")[index]} $name"
    }
    val path = parsed.firstText(pathKeys)
    val subject = parsed.firstText(if (kind == "grep") queryKeys else if (kind == "glob") globKeys else pathKeys)
    val location = if (kind in listOf("grep", "glob") && subject != null && path != null && subject != path) "$subject · $path" else subject
    val actions = mapOf("read" to listOf("正在读取", "已读取", "读取失败"), "write" to listOf("正在写入", "已写入", "写入失败"), "edit" to listOf("正在编辑", "已编辑", "编辑失败"), "delete" to listOf("正在删除", "已删除", "删除失败"), "grep" to listOf("正在搜索", "已搜索", "搜索失败"), "glob" to listOf("正在查找", "已查找", "查找失败"))
    val action = actions.getValue(kind)[index]
    return if (omitFilePath) action else "$action ${location ?: name}"
}

internal fun isBrowserActivity(name: String) = browserName.containsMatchIn(name)
internal data class CodeProgram(val code: String, val description: String?, val truncated: Boolean)
internal fun codeExecutionInput(input: String): CodeProgram {
    val parsed = parseToolInput(input)
    (parsed.opt("code") as? String)?.let { return CodeProgram(it, parsed.firstText(listOf("description")), false) }
    val partial = partialString(input, "code", true)
    return CodeProgram(partial?.first ?: input, partialString(input, "description")?.first, partial?.second ?: false)
}
internal fun toolInputFileDiff(name: String, input: String): JSONObject? {
    val kind = nativeFileKind(name)
    if (kind !in listOf("write", "edit")) return null
    val parsed = parseToolInput(input)
    val before = if (kind == "write") "" else parsed.firstString(listOf("old_string", "oldString", "old_text", "oldText", "before")) ?: return null
    val after = parsed.firstString(if (kind == "write") listOf("content", "text", "data") else listOf("new_string", "newString", "new_text", "newText", "after")) ?: return null
    return json("operation" to kind, "path" to parsed.firstText(pathKeys), "before" to before, "after" to after).apply { if (parsed.optBoolean("__truncated")) put("truncated", true) }
}

private val fileActions = linkedMapOf("read" to "读取", "edit" to "编辑", "write" to "创建", "delete" to "删除")
private val countedActions = linkedMapOf(
    "command" to Triple("运行了", "正在运行命令", "条命令"),
    "browser" to Triple("操作了", "正在操作浏览器", "次浏览器"),
    "web" to Triple("检索了", "正在检索网页", "次网页"),
    "search" to Triple("搜索了", "正在搜索文件", "次文件"),
    "agent" to Triple("调度了", "正在调度子 Agent", "个子 Agent"),
)
internal data class ToolClusterSummary(val label: String, val kind: String, val failed: Int, val standalone: Boolean)

internal fun formatToolClusterSummary(blocks: List<MobileTimelineBlock>): ToolClusterSummary {
    data class Step(val kind: String, val status: String, val name: String, val paths: List<String> = emptyList(), val mcp: Pair<String, String>? = null)
    val steps = blocks.map { block ->
        val payload = block.toolPayload
        if (block.type == "file.changed") {
            val kind = when (payload.text("changeType")) { "added" -> "write"; "deleted" -> "delete"; else -> "edit" }
            Step(kind, block.status, "", listOf(payload.text("path")).filter(String::isNotBlank))
        } else {
            val name = payload.text("toolName", payload.text("command", "工具"))
            val input = payload.text("inputSummary")
            val subagent = payload.optJSONObject("subagent")
            val status = subagent?.text("status").orEmpty().ifBlank { block.status }
            val mcp = mcpCall(name, input)
            val diff = payload.optJSONObject("fileDiff")
            val kind = when {
                subagent != null -> "agent"
                isBrowserActivity(name) -> "browser"
                mcp != null -> "mcp"
                block.type.startsWith("command.") -> "command"
                diff != null -> diff.text("operation", "edit")
                else -> toolActivityKind(name, input)
            }
            val paths = if (kind in fileActions) {
                val parsed = parseToolInput(input)
                (parsed.strings("paths") + parsed.strings("files") + parsed.strings("filePaths")).filter(String::isNotBlank)
                    .ifEmpty { listOfNotNull(diff?.text("path")?.takeIf(String::isNotBlank) ?: parsed.firstText(pathKeys)) }
            } else emptyList()
            Step(kind.takeIf { it in fileActions || it in countedActions || it == "mcp" && mcp != null } ?: "tool", status, name, paths, mcp)
        }
    }
    val kinds = fileActions.keys + countedActions.keys + listOf("mcp", "tool")
    val categories = steps.groupBy { it.kind }
    val sections = kinds.mapNotNull { kind ->
        val group = categories[kind] ?: return@mapNotNull null
        val running = group.any { it.status == "running" }
        val count = group.size
        val label = when (kind) {
            in fileActions -> {
                val files = group.flatMap { it.paths }.toSet().size + group.count { it.paths.isEmpty() }
                "${if (running) "正在" else ""}${fileActions[kind]} $files 个文件"
            }
            in countedActions -> {
                val (done, active, unit) = countedActions.getValue(kind)
                if (running) "$active · $count" else "$done $count $unit"
            }
            "mcp" -> {
                val servers = group.groupBy { it.mcp!!.first.lowercase() }.values
                val action = if (running) "正在调用" else "调用了"
                when (servers.size) {
                    1 -> {
                        val server = group.first().mcp!!.first
                        val active = group.lastOrNull { it.status == "running" }?.mcp?.second
                        if (active == null) "$action $server · $count 次"
                        else "$action $server · $active" + if (count > 1) " ($count)" else ""
                    }
                    2 -> "$action " + servers.joinToString(" · ") { "${it.first().mcp!!.first} (${it.size})" }
                    else -> "$action ${servers.size} 个 MCP 服务 · $count 次"
                }
            }
            else -> {
                val name = group.map { it.name }.distinct().singleOrNull()?.takeIf(String::isNotBlank)
                "${if (running) "正在调用" else "调用了"} $count 次${name?.let { " $it" } ?: "工具"}"
            }
        }
        label to group.sumOf { maxOf(1, it.paths.size) }
    }
    val label = if (sections.size <= 3) sections.joinToString(" · ") { it.first }
        else sections.take(2).joinToString(" · ") { it.first } + " · 等 ${sections.drop(2).sumOf { it.second }} 项操作"
    val kind = kinds.firstOrNull { it in categories } ?: "tool"
    return ToolClusterSummary(label, kind, steps.count { it.status == "failed" },
        blocks.size == 1 && kind !in fileActions && kind != "command")
}
internal fun reasoningPreview(text: String): String {
    // Keep the newest line during streaming and after completion. Trailing
    // paragraph separators must not clear the preview or rewind it to the start.
    return text.trimEnd().substringAfterLast('\n').replace(Regex("^\\s*(?:#{1,6}\\s+|[-*>]\\s+)"), "")
        .replace(Regex("\\[([^]]+)]\\([^)]*\\)"), "$1").replace(Regex("\\*\\*|__|`"), "").trim().takeLast(500)
}
internal data class ToolOutput(val status: String? = null, val fields: List<Pair<String, String>> = emptyList(), val text: String = "")
internal fun toolOutput(output: String): ToolOutput {
    if (output.isEmpty()) return ToolOutput()
    val value = runCatching { JSONObject(output) }.getOrNull() ?: return Regex("^requested cancellation of job\\s+(\\S+)\\s*$", RegexOption.IGNORE_CASE).find(output.trim())?.let {
        ToolOutput("已请求取消", listOf("任务" to it.groupValues[1]))
    } ?: ToolOutput(text = output)
    val status = when {
        value.text("outcome") == "cancellation-requested" -> "已请求取消"
        value.text("outcome") == "already-finished" -> "任务已结束"
        value.text("kind") == "promoted" -> "已转为后台任务"
        value.text("status") == "running" -> "后台运行中"
        value.text("status") == "stopping" -> "正在停止"
        else -> null
    }
    val labels = mapOf("jobId" to "任务", "cwd" to "目录", "timeoutMs" to "超时", "exitCode" to "退出码", "status" to "状态", "kind" to "类型")
    val fields = value.keys().asSequence().mapNotNull { key ->
        val entry = value.opt(key)
        if (key == "output" || entry == null || entry == JSONObject.NULL || entry == "" || status != null && key in listOf("kind", "status", "outcome")) null
        else (labels[key] ?: key) to when {
            key == "timeoutMs" && entry is Number -> "${java.math.BigDecimal(entry.toString()).divide(java.math.BigDecimal(1000)).stripTrailingZeros().toPlainString()}s"
            entry is JSONObject -> entry.toString(2)
            entry is JSONArray -> entry.toString(2)
            else -> entry.toString()
        }
    }.toList()
    return ToolOutput(status, fields, value.opt("output") as? String ?: "")
}
internal data class ToolCallBranch(val call: JSONObject, val children: List<ToolCallBranch>)
internal fun toolCallTree(calls: List<JSONObject>): List<ToolCallBranch> {
    val byId = calls.associateBy { it.text("callId") }
    val children = calls.filter { it.text("parentCallId").isNotBlank() && it.text("parentCallId") != it.text("callId") && byId.containsKey(it.text("parentCallId")) }.groupBy { it.text("parentCallId") }
    val seen = mutableSetOf<String>()
    fun build(call: JSONObject, depth: Int): ToolCallBranch {
        seen.add(call.text("callId"))
        val nested = mutableListOf<ToolCallBranch>()
        if (depth < 32) children[call.text("callId")].orEmpty().forEach { if (it.text("callId") !in seen) nested += build(it, depth + 1) }
        return ToolCallBranch(call, nested)
    }
    val result = mutableListOf<ToolCallBranch>()
    calls.forEach { if ((it.text("parentCallId").isEmpty() || !byId.containsKey(it.text("parentCallId")) || it.text("parentCallId") == it.text("callId")) && it.text("callId") !in seen) result += build(it, 0) }
    calls.forEach { if (it.text("callId") !in seen) result += build(it, 0) }
    return result
}
internal fun activityStatus(item: ActivityItem) = if (item.running) "running" else if (item.payload.opt("success") == false || item.payload.has("exitCode") && item.payload.optInt("exitCode") != 0 || item.payload.optJSONObject("subagent")?.text("status") == "failed") "failed" else "done"

internal fun codeCallDescription(call: JSONObject): Pair<String, String> {
    val raw = call.opt("input")
    val args = if (raw is JSONObject) raw else runCatching { JSONObject(raw?.toString().orEmpty()) }.getOrDefault(JSONObject())
    val name = call.text("name").replace(Regex("^tools[.:/]"), "")
    val titles = mapOf("pwsh" to "运行命令", "bash" to "运行命令", "exec_command" to "运行命令", "write_stdin" to "终端输入", "read" to "读取文件", "read_file" to "读取文件", "read_image" to "查看图片", "write" to "写入文件", "write_file" to "写入文件", "edit" to "编辑文件", "apply_patch" to "修改文件", "glob" to "查找文件", "grep" to "搜索内容", "run_code" to "执行代码", "job_output" to "查看任务输出", "job_poll" to "查看任务状态", "job_list" to "后台任务", "job_cancel" to "取消后台任务", "job_kill" to "取消后台任务")
    val detail = args.firstText(listOf("description", "file_path", "path", "filePath", "command", "cmd", "query", "pattern", "jobId", "job_id")).orEmpty().lineSequence().firstOrNull().orEmpty()
    return (titles[name] ?: call.text("name")) to listOfNotNull(detail.takeIf(String::isNotBlank), toolOutput(call.text("output")).status).joinToString(" · ")
}
