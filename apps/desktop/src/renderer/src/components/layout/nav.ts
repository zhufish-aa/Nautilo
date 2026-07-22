import {
  Bot,
  FolderKanban,
  GitPullRequest,
  MessagesSquare,
  Settings,
  Users,
  Workflow,
  type LucideIcon
} from "lucide-react";
import type { NavKey } from "../../lib/types";

export interface NavEntry {
  key: NavKey;
  path: string;
  icon: LucideIcon;
}

export const NAV_ENTRIES: NavEntry[] = [
  { key: "projects", path: "/projects", icon: FolderKanban },
  { key: "agents", path: "/agents", icon: Bot },
  { key: "teams", path: "/teams", icon: Users },
  { key: "tasks", path: "/tasks", icon: Workflow },
  { key: "sessions", path: "/sessions", icon: MessagesSquare },
  { key: "runs", path: "/runs", icon: GitPullRequest },
  { key: "settings", path: "/settings", icon: Settings }
];
