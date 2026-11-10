import { Atom, Braces, Code2, Cog, FileCode2, FileImage, FileJson2, FileText, Terminal } from "lucide-react";

/** File identity stays visible in both the navigation and editor toolbar. */
export function FileTypeIcon({ path, size = 16 }: { path: string; size?: number }): JSX.Element {
  const extension = path.split(/[\\/]/).at(-1)?.split(".").at(-1)?.toLowerCase();
  const props = { size, "aria-hidden": true as const, strokeWidth: 1.6 };
  if (extension === "ts" || extension === "js" || extension === "mjs" || extension === "cjs") {
    const ts = extension === "ts";
    return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="review-file-type">
      <rect width="24" height="24" rx="1" fill={ts ? "#3178C6" : "#E3BF46"} />
      <text x="22" y="21" textAnchor="end" fill={ts ? "#fff" : "#242424"} fontFamily="Arial, sans-serif" fontWeight="700" fontSize="13">{ts ? "TS" : "JS"}</text>
    </svg>;
  }
  if (extension === "tsx" || extension === "jsx") return <Atom {...props} color="#2A9BAB" className="review-file-type" />;
  if (extension === "css" || extension === "scss" || extension === "less") return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="review-file-type"><path fill="#3B7DB8" d="M4 3h17l-3 16-8 3-7-3 1-5h4l-.4 2 3 1.1 3.6-1.2.6-3.3H4.8l.6-3.2h10.2l.6-3H3.4z" /></svg>;
  if (extension === "rs") return <span className="review-file-type review-rust-icon" style={{ width: size, height: size }}><Cog {...props} color="#756454" /><b>R</b></span>;
  if (extension === "json" || extension === "jsonc" || extension === "json5") return <FileJson2 {...props} color="#8B6C34" className="review-file-type" />;
  if (["png", "jpg", "jpeg", "webp", "gif", "svg", "ico"].includes(extension ?? "")) return <FileImage {...props} color="#A276B2" className="review-file-type" />;
  if (["sh", "ps1", "bat", "cmd"].includes(extension ?? "")) return <Terminal {...props} color="#749782" className="review-file-type" />;
  if (["html", "vue", "svelte"].includes(extension ?? "")) return <Code2 {...props} color="#C17B58" className="review-file-type" />;
  if (["yaml", "yml", "toml"].includes(extension ?? "")) return <Braces {...props} color="#89939A" className="review-file-type" />;
  if (["py", "go", "c", "cpp", "h", "java", "kt", "dart"].includes(extension ?? "")) return <FileCode2 {...props} color="#8AA0B9" className="review-file-type" />;
  return <FileText {...props} className="review-file-type" />;
}
