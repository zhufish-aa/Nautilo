package app.nautilo.mobile

import android.graphics.Bitmap
import android.text.style.StyleSpan
import android.view.View
import android.view.ViewGroup
import android.widget.HorizontalScrollView
import android.widget.TableLayout
import android.widget.TextView
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.nautilo.mobile.data.*
import app.nautilo.mobile.ui.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Uses native widgets and the shipping composables. No model requests or account changes. */
@RunWith(AndroidJUnit4::class)
class PresentationTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun descendants(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { descendants(view.getChildAt(it)) } else emptyList()
    private fun screenshot(name: String) {
        instrumentation.waitForIdleSync()
        Thread.sleep(400)
        val target = File(instrumentation.targetContext.filesDir, "$name.png")
        target.outputStream().use { instrumentation.uiAutomation.takeScreenshot().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    @Test fun tablesRenderNativelyWithEmphasisAndIndependentHorizontalScrolling() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity -> activity.setContent {
                NautiloTheme { LazyColumn(Modifier.fillMaxSize().background(Color(0xFFFAFCFE)).padding(horizontal = 20.dp).statusBarsPadding()) { item {
                    Spacer(Modifier.height(25.dp))
                    Text("目录概览", style = androidx.compose.material3.MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.height(20.dp))
                    Markdown("当前目录共有 **45 个文件夹、16 个文件**。\n\n| 目录 | 内容 |\n| :--- | :--- |\n| `apps/desktop/` | **Electron** 桌面端和 React 前端 |\n| `rust/` | Rust 后端和插件 |\n| `packages/` | 共享 TypeScript 包 |\n| `docs/` | 项目文档 |\n\n| Harness | 模型 | 输入 | 输出 | 缓存 |\n| --- | --- | ---: | ---: | ---: |\n| Codex | gpt-6.1-sol | 2,148 | 1,024 | 98% |\n\n转义内容：\n\n| 字段 | 值 |\n| --- | --- |\n| 文本 | A\\|B |\n\n```text\n| fenced | code |\n| --- | --- |\n```")
                } } }
            } }
            screenshot("markdown-native")
            scenario.onActivity { activity ->
                val views = descendants(activity.window.decorView)
                assertEquals(3, views.filterIsInstance<TableLayout>().size)
                val cells = views.filterIsInstance<TextView>()
                assertTrue(cells.any { it.text.toString().contains("Electron") && (it.text as? android.text.Spanned)?.getSpans(0, it.text.length, io.noties.markwon.core.spans.StrongEmphasisSpan::class.java)?.isNotEmpty() == true })
                assertTrue(cells.any { it.text.toString() == "A|B" })
                assertTrue(views.filterIsInstance<HorizontalScrollView>().any { it.getChildAt(0).width > it.width })
            }
        }
    }
    @Test fun diffUsesDedicatedScreenAndSyntaxColors() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val model = ViewModelProvider(activity)[MobileViewModel::class.java]
                val patch = "--- a/browser-scroll.ts\n+++ b/browser-scroll.ts\n@@ -118,5 +118,9 @@\n export async function scrollBrowserPage(page: Page) {\n-  await dispatchWheel(page, 15000);\n+  const before = await metrics(page);\n+  await dispatchWheel(page, 1000);\n+  const after = await metrics(page);\n+  if (before.scrollY === after.scrollY) {\n+    throw new Error(\"SCROLL_NO_EFFECT\");\n+  }\n   return after;\n }\n"
                activity.setContent { NautiloTheme {
                    Column(Modifier.fillMaxSize().background(Backdrop).statusBarsPadding().navigationBarsPadding()) {
                        Text("文件变更", Modifier.padding(20.dp), style = androidx.compose.material3.MaterialTheme.typography.titleLarge)
                        FileDiffScreen(MobileState(diffPath = "apps/desktop/src/main/browser-scroll.ts", workspace = listOf(json("path" to "apps/desktop/src/main/browser-scroll.ts", "patch" to patch))), model)
                    }
                } }
            }
            screenshot("diff-native")
        }
    }
}
