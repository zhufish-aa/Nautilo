import { defineConfig, mergeConfig } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import shared from "./visual.vite.config.mts";
export default mergeConfig(shared, defineConfig({
  cacheDir: resolve(__dirname, "../../node_modules/.vite-workflow-qa"),
  plugins: [{
    name: "engine-workflow-fixture",
    resolveId(id) { if (id === "virtual:workflow-fixtures") return "\0" + id; },
    load(id) {
      if (id !== "\0virtual:workflow-fixtures") return;
      const file = process.env.NAUTILO_WORKFLOW_QA_STATE;
      if (!file) throw new Error("Generate the Rust engine workflow fixture first and set NAUTILO_WORKFLOW_QA_STATE.");
      this.addWatchFile(file);
      const runs = JSON.parse(readFileSync(file,"utf8")), evidence: { artifacts: unknown[]; approvals: unknown[] } = { artifacts: [], approvals: [] };
      for (const label of ["merge","commands"]) {
        const path = file + ".workspace-" + label + ".json"; if (!existsSync(path)) continue;
        this.addWatchFile(path); const saved = JSON.parse(readFileSync(path,"utf8"));
        runs["workspace-" + label] = saved.run; evidence.artifacts.push(...saved.artifacts); evidence.approvals.push(...saved.approvals);
      }
      if (existsSync(file + ".legacy-plan.json")) { this.addWatchFile(file + ".legacy-plan.json"); runs["legacy-plan"] = JSON.parse(readFileSync(file + ".legacy-plan.json","utf8")); }
      if (existsSync(file + ".task-plan.json")) { const path = file + ".task-plan.json"; this.addWatchFile(path); const saved = JSON.parse(readFileSync(path,"utf8")); runs["task-plan-adopted"] = saved.run; evidence.artifacts.push(...saved.artifacts); evidence.approvals.push(...saved.approvals); }
      return "export const evidence = " + JSON.stringify(evidence) + "; export default " + JSON.stringify(runs);
    }
  }],
  resolve: { alias: [{ find: /^(?:.*\/lib\/bridge|\.\/bridge)(?:\.ts)?$/, replacement: resolve(__dirname,"workflow-visual-bridge.ts") }] },
  server: { port: 4186 },
  build: { outDir: resolve(__dirname,"../../../../.qa/workflow-visual-dist"), rollupOptions: { input: resolve(__dirname,"workflow-visual.html") } }
}));
