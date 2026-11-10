import { BookOpen, Code2, FilePenLine, FilePlus2, FileText, Globe, Image, Plug, Search, Terminal, Wrench } from "lucide-react";
import { toolActivityKind } from "../../lib/tool-display";
import { isBrowserTool } from "../../lib/browser-display";
import { BrowserActivityIcon } from "./BrowserActivity";

const icons = { command: Terminal, read: FileText, write: FilePlus2, edit: FilePenLine, search: Search, mcp: Plug, skill: BookOpen, web: Globe, image: Image, code: Code2, tool: Wrench };
export function ToolActivityIcon({ name, input }: { name: string; input?: string }): JSX.Element {
  if (isBrowserTool(name)) return <BrowserActivityIcon className="shrink-0 text-accent"/>;
  const Icon = icons[toolActivityKind(name, input)];
  return <Icon size={14} className="shrink-0" aria-hidden />;
}
