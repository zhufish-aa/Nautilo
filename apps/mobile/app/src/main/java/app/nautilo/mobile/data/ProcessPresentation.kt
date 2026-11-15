package app.nautilo.mobile.data

import org.json.JSONArray
import org.json.JSONObject

// Ported from desktop lib/tool-display.ts and lib/process-display.ts.
// Desktop-generated fixtures verify labels, previews, receipts and call ancestry.
private val pathKeys = listOf("path", "file_path", "filePath", "filepath", "target_path", "targetPath", "target_file", "targetFile", "filename", "file")
private val queryKeys = listOf("query", "pattern", "regex", "q", "search", "needle")
private val globKeys = listOf("glob", "pattern", "file_pattern", "filePattern", "include")
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
        matches("mcp") || n.startsWith("codex_apps_") -> "mcp"
        matches("bash|pwsh|shell|shell_command|exec_command|run_command|execute_command|terminal|write_stdin") -> "command"
        matches("read_image|view_image|image_gen|imagegen") -> "image"
        matches("run_code|execute_code|python|node_repl") -> "code"
        matches("web|web_search|web_fetch|fetch_url|browse") -> "web"
        kind in listOf("grep", "glob") -> "search"
        kind != null -> kind
        matches("str_replace|apply_patch|replace_in_file|edit_file") -> "edit"
        matches("view_files|view_file|read_file|read_text_file|open_file") -> "read"
        matches("create_file|write_file") -> "write"
        matches("search|find|list_directory|list_dir|ls") -> "search"
        else -> "tool"
    }
}
internal fun toolActivityLabel(name: String, status: String, input: String = ""): String {
    val index = if (status == "running") 0 else if (status == "done") 1 else 2
    if (toolActivityKind(name, input) == "question") return listOf("等待你的回答", "已提问", "提问未完成")[index]
    val kind = nativeFileKind(name) ?: return "${listOf("正在使用", "已使用", "调用失败")[index]} $name"
    val parsed = parseToolInput(input)
    val path = parsed.firstText(pathKeys)
    val subject = parsed.firstText(if (kind == "grep") queryKeys else if (kind == "glob") globKeys else pathKeys)
    val location = if (kind in listOf("grep", "glob") && subject != null && path != null && subject != path) "$subject · $path" else subject
    val actions = mapOf("read" to listOf("正在读取", "已读取", "读取失败"), "write" to listOf("正在写入", "已写入", "写入失败"), "edit" to listOf("正在编辑", "已编辑", "编辑失败"), "grep" to listOf("正在搜索", "已搜索", "搜索失败"), "glob" to listOf("正在查找", "已查找", "查找失败"))
    return "${actions.getValue(kind)[index]} ${location ?: name}"
}
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
internal fun reasoningPreview(text: String, streaming: Boolean): String {
    val paragraphs = text.trimStart().split(Regex("\\r?\\n[\\t ]*\\r?\\n"))
    return (if (streaming && paragraphs.size > 1) paragraphs[paragraphs.size - 2] else paragraphs.firstOrNull().orEmpty())
        .lineSequence().firstOrNull().orEmpty().replace(Regex("^\\s*(?:#{1,6}\\s+|[-*>]\\s+)"), "")
        .replace(Regex("\\[([^]]+)]\\([^)]*\\)"), "$1").replace(Regex("\\*\\*|__|`"), "").trim().take(500)
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
