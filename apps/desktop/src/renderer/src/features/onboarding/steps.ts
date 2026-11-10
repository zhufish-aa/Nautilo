export interface OnboardingStep {
  id: string;
  title: { zh: string; en: string };
  description: { zh: string; en: string };
  path: string;
  /** The stable tour hook comes first; fallbacks also support older workspaces. */
  target: string;
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: "task",
    title: { zh: "从这里开始", en: "Start here" },
    description: {
      zh: "描述任务，或添加文件。代码与文档都在同一个工作台完成。",
      en: "Describe a task or add files. Work on code and documents in the same workspace."
    },
    path: "/sessions",
    target: '[data-tour="sessions-composer"], .composer'
  },
  {
    id: "project",
    title: { zh: "按项目组织工作", en: "Keep work in projects" },
    description: {
      zh: "选择工作目录。会话会按项目保存在侧栏，方便继续之前的工作。",
      en: "Choose a working directory. Conversations stay grouped by project in the sidebar."
    },
    path: "/sessions",
    target: '[data-tour="session-project"]'
  },
  {
    id: "agent",
    title: { zh: "选择你的助手", en: "Choose your assistant" },
    description: {
      zh: "选择 Agent，按需配置模型或协作团队。之后也可以在设置中调整。",
      en: "Choose an agent, then a model or collaboration team when needed. You can configure them in Settings."
    },
    path: "/sessions",
    target: '[data-tour="session-agent"], .starter-picker'
  }
];
