import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useSettingsStore } from "../stores/settings";
import type { LocaleCode } from "./utils";

const zh = {
  app: {
    name: "AgentHub",
    tagline: "本地多 Agent 编程工作台",
    skipToContent: "跳到主内容",
    browserBadge: "浏览器预览",
    windowMinimize: "最小化",
    windowMaximize: "最大化",
    windowRestore: "还原",
    windowClose: "关闭"
  },
  nav: {
    section: "工作台",
    projects: "项目",
    agents: "Agent",
    teams: "团队",
    tasks: "任务",
    sessions: "会话",
    runs: "运行",
    settings: "设置"
  },
  common: {
    add: "添加",
    create: "新建",
    edit: "编辑",
    save: "保存",
    cancel: "取消",
    remove: "移除",
    close: "关闭",
    confirm: "确认",
    browse: "浏览…",
    retry: "重试",
    back: "返回",
    optional: "可选",
    none: "无",
    enabled: "已启用",
    disabled: "已禁用",
    loading: "加载中…",
    unknown: "未知",
    notConfigured: "未配置",
    count: "{count} 项"
  },
  status: {
    agent: {
      offline: "离线",
      available: "可用",
      running: "运行中",
      waiting_input: "等待输入",
      waiting_approval: "等待审批",
      error: "错误",
      disabled: "已禁用"
    },
    provider: {
      ready: "就绪",
      missing: "未检测到",
      outdated: "版本过低",
      error: "检测失败"
    },
    run: {
      planning: "规划中",
      executing: "执行中",
      verifying: "验收中",
      waiting_user: "等待用户"
    },
    git: {
      clean: "工作区干净",
      dirty: "{count} 个未提交更改"
    }
  },
  capabilities: {
    headless_structured: "结构化输出",
    headless_text: "文本输出",
    long_running_stdin: "长驻会话",
    pty_interactive: "交互终端",
    provider_server: "本地服务"
  },
  taskTypes: {
    code: "编码",
    refactor: "重构",
    review: "审查",
    test: "测试",
    docs: "文档",
    debug: "调试",
    plan: "规划",
    research: "调研"
  },
  strengthAreas: {
    coding: "代码生成",
    refactor: "重构",
    review: "代码审查",
    testing: "测试",
    docs: "文档",
    debug: "调试",
    planning: "任务规划",
    research: "调研"
  },
  envPolicies: {
    "env-standard": {
      name: "标准白名单",
      description: "仅传递 Provider 所需的最小环境变量集"
    },
    "env-strict": {
      name: "严格隔离",
      description: "不继承宿主机环境，逐项显式声明"
    },
    "env-custom": {
      name: "自定义",
      description: "使用用户自定义的环境变量白名单"
    }
  },
  risk: {
    level: {
      info: "提示",
      warning: "警告",
      critical: "严重"
    },
    texts: {
      dirtyWorktree: "工作区存在未提交更改，并行任务建议使用独立 worktree",
      noGit: "目录不是 Git 仓库，团队委派模式不可用，仅支持单 Agent 模式",
      nodeVersionMismatch: "检测到多个 Node 版本管理器配置，可能导致环境不一致",
      unpinnedDeps: "部分依赖未锁定版本，构建结果可能不可复现",
      largeRepo: "仓库体积较大，首次索引和扫描可能较慢",
      noTestCommand: "未检测到测试命令，建议先在项目中注册验收命令模板"
    }
  },
  projects: {
    title: "项目",
    subtitle: "管理本地项目与运行状态",
    count: "{count} 个项目",
    add: "添加项目",
    addTitle: "添加本地项目",
    addDesc: "选择一个本地目录，AgentHub 会扫描它的 Git、技术栈与目录结构。",
    pathLabel: "项目目录",
    pathPlaceholder: "例如 C:\\work\\my-project",
    nameLabel: "显示名称",
    namePlaceholder: "默认使用目录名",
    browserPickerHint: "浏览器预览模式无法打开系统目录选择器，请手动输入路径。",
    scanning: "正在扫描项目…",
    scanHint: "扫描为只读操作，不会修改目录内容",
    remove: "移除项目",
    removeTitle: "移除项目",
    removeDesc: "仅从 AgentHub 移除「{name}」的配置，不会删除磁盘上的任何文件。",
    addedToast: "项目「{name}」已添加",
    removedToast: "项目「{name}」已移除",
    duplicateToast: "该目录已在项目列表中",
    rescanDoneToast: "「{name}」扫描完成",
    empty: {
      title: "还没有项目",
      desc: "添加一个本地目录作为工作区，开始与 Agent 协作。",
      action: "添加第一个项目"
    },
    card: {
      activeRun: "当前运行",
      lastOpened: "最近打开 {time}",
      noScan: "尚未扫描",
      rescan: "重新扫描"
    },
    detail: {
      back: "返回项目列表",
      gitTitle: "Git 仓库",
      stackTitle: "技术栈",
      pathsTitle: "目录映射",
      risksTitle: "风险提示",
      runTitle: "当前运行",
      branch: "当前分支",
      defaultBranch: "默认分支",
      remote: "远端",
      worktree: "工作区状态",
      noGit: "非 Git 仓库",
      frontendPaths: "前端路径",
      backendPaths: "后端路径",
      noPaths: "未识别到明确的前后端目录",
      noRisks: "未发现风险，项目状态良好。",
      confidence: "置信度 {value}%",
      goal: "目标",
      agent: "执行 Agent",
      startedAt: "开始于 {time}",
      notScanned: "该项目尚未完成扫描。",
      scanNow: "立即扫描"
    }
  },
  agents: {
    title: "Agent",
    subtitle: "管理本机 CLI 检测与 Agent 实例配置",
    tabs: {
      instances: "Agent 实例",
      providers: "Provider 检测"
    },
    instances: {
      desc: "实例定义了「用哪个 CLI、什么模型、什么参数」运行 Agent。",
      new: "新建 Agent",
      emptyTitle: "还没有 Agent 实例",
      emptyDesc: "创建一个实例，绑定 Provider、模型与能力配置。",
      emptyAction: "新建第一个 Agent",
      updatedAt: "更新于 {time}",
      disableHint: "禁用后不会被主 Agent 委派",
      enableHint: "启用后可参与团队与委派",
      model: "模型",
      args: "参数",
      defaultModel: "默认模型",
      apiKeySet: "API Key 已配置",
      edit: "编辑实例"
    },
    editor: {
      createTitle: "新建 Agent 实例",
      editTitle: "编辑 Agent 实例",
      basic: {
        name: "实例名称",
        namePlaceholder: "例如 codex-main",
        provider: "Provider",
        providerPlaceholder: "选择 CLI Provider",
        model: "模型",
        modelPlaceholder: "例如 gpt-5-codex",
        modelHint: "留空则使用 Provider 默认模型",
        modelLoading: "正在从本机 CLI 获取可用模型…",
        modelLoaded: "已从本机 CLI 获取 {count} 个模型；默认模型：{default}",
        modelCustom: "当前为自定义模型标识，将按原值传给 CLI。",
        modelDefault: "默认",
        modelDefaultPlaceholder: "留空使用默认模型 {model}",
        refreshModels: "重新获取模型",
        reasoning: "推理深度",
        reasoningDefault: "使用模型默认值",
        reasoningHint: "由本机 CLI 返回的 {model} 可用推理深度",
        reasoningUnavailable: "选择模型后从本机 CLI 获取可用推理深度",
        args: "启动参数",
        argsPlaceholder: "输入参数后回车，例如 --full-auto",
        argsHint: "作为 baseArgs 传递给 CLI，按顺序生效",
        profile: "配置档案",
        profilePlaceholder: "例如 default",
        envPolicy: "环境策略",
        enabled: "启用该实例",
        enabledHint: "禁用后不会被主 Agent 委派",
        credentials: "凭证与接入（可选）",
        apiKey: "API Key",
        apiKeyPlaceholder: "sk-...",
        apiKeyHint: "仅保存在本机，运行时注入 CLI 环境变量",
        baseUrl: "API 请求地址",
        baseUrlPlaceholder: "https://api.example.com/v1",
        baseUrlHint: "第三方中转/代理服务时填写，留空走默认端点",
        showKey: "显示 API Key",
        hideKey: "隐藏 API Key"
      },
      savedToast: "「{name}」已保存",
      createdToast: "「{name}」已创建",
      nameRequired: "请填写实例名称",
      providerRequired: "请选择 Provider"
    },
    providers: {
      desc: "本机 CLI 的安装与可用性检测结果。",
      notice: "仅展示本机 CLI 的检测结果；登录与授权由各 CLI 自行管理，AgentHub 不接管第三方账号流程。",
      executable: "可执行路径",
      version: "版本",
      minVersion: "需要 ≥ {version}",
      capabilities: "能力",
      checkedAt: "检测于 {time}",
      redetect: "重新检测",
      redetecting: "检测中…",
      redetectDone: "{name} 检测完成",
      missingHint: "未在 PATH 中找到可执行文件，安装后点击重新检测。",
      errorHint: "检测过程中出现异常，请确认 CLI 可正常运行。",
      outdatedHint: "当前版本低于平台支持的最低版本，请升级后重新检测。"
    }
  },
  settings: {
    title: "设置",
    subtitle: "外观、语言与界面偏好",
    appearance: {
      title: "外观",
      desc: "选择界面主题，偏好会保存在本机",
      dark: "深色",
      light: "浅色",
      system: "跟随系统"
    },
    language: {
      title: "语言",
      desc: "切换界面显示语言",
      zh: "简体中文",
      en: "English"
    },
    motion: {
      title: "界面动效",
      desc: "减少过渡与动画效果（默认跟随系统偏好）",
      reduce: "减少动效"
    },
    nav: {
      title: "导航模块",
      desc: "控制侧边栏显示哪些模块；项目、Agent 与设置始终可见",
      locked: "固定显示"
    },
    about: {
      title: "关于",
      appVersion: "应用版本",
      runtime: "运行环境",
      platform: "平台",
      mode: "运行模式",
      modeElectron: "Electron 桌面",
      modeBrowser: "浏览器预览（Core 不可用）",
      dataNote: "Electron 桌面端的项目、Agent、团队、会话和运行数据均来自 Core Daemon 与本地 SQLite。浏览器预览不会生成模拟业务数据。"
    }
  },
  teams: {
    title: "团队",
    subtitle: "自定义成员、角色与委派策略",
    new: "新建团队",
    count: "{count} 支团队",
    empty: {
      title: "还没有团队",
      desc: "创建一支团队，把 Agent 实例编成一支可委派的队伍。",
      action: "创建第一支团队"
    },
    card: {
      members: "{count} 名成员",
      main: "主 Agent",
      delegatePool: "子 Agent 池",
      updatedAt: "更新于 {time}",
      untitled: "未命名团队"
    },
    editor: {
      back: "返回团队列表",
      nameLabel: "团队名称",
      namePlaceholder: "例如 我的攻坚队",
      deleteTeam: "删除团队",
      deleteTitle: "删除团队",
      deleteDesc: "仅删除团队配置「{name}」，不影响 Agent 实例与项目。",
      deletedToast: "团队「{name}」已删除",
      policyTitle: "委派策略",
      policyDesc: "控制主 Agent 何时可以委派任务",
      membersTitle: "成员",
      membersDesc: "成员完全由你定义；不创建就不会出现",
      addMember: "添加成员",
      mainBadge: "主 Agent",
      setMain: "设为主 Agent",
      mainRunningNote: "当前有会话正在运行，更换主 Agent 将在下次运行生效。",
      remove: "移除成员",
      removeTitle: "移除成员",
      removeDesc: "将「{name}」从团队中移除，不影响其 Agent 实例。",
      validationTitle: "团队校验"
    },
    member: {
      nameLabel: "成员名称",
      namePlaceholder: "例如 阿柯",
      instanceLabel: "绑定实例",
      instancePlaceholder: "选择 Agent 实例",
      maxConcurrent: "最大并发任务",
      taskTypes: "可承接任务类型",
      customTaskTypePlaceholder: "自定义任务类型，回车添加",
      enabled: "启用成员",
      enabledHint: "禁用成员不会被主 Agent 委派",
      createTitle: "添加成员",
      editTitle: "编辑成员",
      tabs: { basic: "基本", role: "角色" }
    },
    role: {
      name: "角色名称",
      namePlaceholder: "例如 队长",
      description: "角色描述",
      descriptionPlaceholder: "这个角色负责什么、不负责什么",
      responsibilities: "职责",
      responsibilitiesPlaceholder: "例如 拆解目标，回车添加",
      strengths: "擅长领域",
      strengthsHint: "自由输入领域并用 1–5 分标注",
      addStrength: "添加领域",
      areaPlaceholder: "输入或选择领域",
      limitations: "限制",
      limitationsPlaceholder: "例如 不执行数据库迁移，回车添加",
      systemInstructions: "系统提示词",
      systemInstructionsPlaceholder: "注入到该成员会话的额外指令，可选"
    },
    policy: {
      autonomous: "自主委派",
      autonomousDesc: "主 Agent 自行判断自己完成还是委派，无需逐次确认",
      ask_before_delegate: "委派前询问",
      ask_before_delegateDesc: "主 Agent 提议委派后，等待你批准才执行",
      direct_only: "仅主 Agent",
      direct_onlyDesc: "禁止委派，所有工作由主 Agent 自己完成"
    },
    validation: {
      noMembers: "团队还没有成员，无法作为运行目标",
      noEnabled: "所有成员都被禁用，主 Agent 无人可用",
      mainMissing: "尚未指定主 Agent",
      mainDisabled: "主 Agent「{name}」已被禁用",
      duplicateInstance: "成员 {names} 绑定了同一个实例",
      instanceMissing: "成员「{name}」绑定的实例已被删除",
      instanceDisabled: "成员「{name}」绑定的实例「{instance}」已禁用",
      memberDisabled: "成员「{name}」已禁用，不会被委派",
      ok: "校验通过，团队配置可用"
    }
  },
  sessions: {
    title: "会话",
    new: "新建会话",
    newTitle: "新建会话",
    newDesc: "选择一个项目与聊天目标（团队或单个 Agent）。",
    projectLabel: "项目",
    targetLabel: "聊天目标",
    cliLabel: "主会话 CLI",
    cliPlaceholder: "选择本次主会话使用的 Agent 实例",
    delegateTeamLabel: "可委派团队（可选）",
    delegateTeamHint: "团队只提供子 Agent；当前会话的 CLI 始终是主 Agent",
    noDelegateTeam: "不使用团队",
    noDelegateTeamHint: "当前会话由所选 CLI 独立完成",
    titleLabel: "标题",
    titlePlaceholder: "默认按首条消息生成",
    empty: {
      title: "还没有会话",
      desc: "新建一个会话，开始与 Agent 或团队协作。",
      action: "新建会话"
    },
    noSelection: "选择或新建一个会话开始聊天",
    targets: { team: "团队", agent: "单个 Agent", member: "成员" },
    panel: {
      title: "Agent 分配",
      mainBadge: "主",
      mainSession: "主会话",
      subSessions: "子 Agent 会话",
      noSub: "主 Agent 直接完成，未产生子会话",
      noTasks: "未委派任务",
      directNote: "主 Agent 直接完成时不显示子任务",
      tasksTitle: "任务",
      openSession: "打开会话",
      policy: "委派策略",
      editTeam: "编辑团队",
      single: "单 Agent 会话",
      instanceInfo: "当前实例"
    },
    composer: {
      placeholder: "向 {name} 发送消息…",
      send: "发送",
      stop: "停止",
      hint: "Enter 发送，Shift+Enter 换行",
      advanced: "Advanced",
      speed: "速度",
      standard: "标准",
      fast: "快速",
      fastUnavailable: "当前模型不支持快速模式"
    },
    header: {
      dag: "任务 DAG",
      artifacts: "Diff / 产物",
      terminal: "原始终端",
      untitled: "未命名会话"
    },
    cards: {
      command: "命令执行",
      exitCode: "退出码 {code}",
      output: "输出",
      running: "运行中",
      verification: "验收",
      passed: "通过",
      failed: "失败",
      duration: "{seconds}s",
      log: "日志",
      approval: "审批请求",
      approve: "批准",
      reject: "拒绝",
      scope: "范围",
      scopeOnce: "仅本次",
      scopeRun: "本次运行",
      scopeTask: "该任务",
      scopeProject: "该项目",
      scopeGlobal: "全局",
      approved: "已批准",
      rejected: "已拒绝",
      decision: { direct: "直接完成", delegate: "单次委派", plan: "任务计划" },
      handoff: "上下文交接",
      openSub: "查看子会话",
      error: "错误",
      retryable: "可重试",
      notRetryable: "不可重试",
      files: "{count} 个文件",
      viewDiff: "查看 Diff",
      taskAssigned: "任务分配"
    },
    drawers: {
      terminal: "原始终端",
      terminalNote: "仅用于 PTY/调试兜底，不替代聊天界面",
      terminalEmpty: "该会话还没有原始输出",
      artifacts: "Diff 与产物",
      noArtifacts: "该会话还没有产物",
      dag: "任务依赖图",
      dagNote: "仅在主 Agent 创建任务计划时展示",
      tabs: { diff: "Diff", contract: "API 契约", test: "测试报告", commit: "提交" }
    },
    status: {
      idle: "空闲",
      running: "运行中",
      waiting_input: "等待输入",
      waiting_approval: "等待审批",
      completed: "已完成",
      failed: "失败",
      archived: "已归档"
    },
    taskStatus: {
      draft: "草稿",
      ready: "就绪",
      blocked_dependency: "等待依赖",
      queued: "排队中",
      running: "运行中",
      waiting_user: "等待用户",
      waiting_approval: "等待审批",
      verifying: "验收中",
      review_required: "待审查",
      merge_ready: "待合并",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消"
    }
  },
  placeholder: {
    badge: "后续里程碑",
    teams: {
      title: "自定义团队",
      desc: "Team Builder、角色与委派策略将在 M2 里程碑交付。成员完全由你定义，不会出现固定角色。"
    },
    tasks: {
      title: "任务看板",
      desc: "任务 DAG、依赖与状态追踪将在主 Agent 规划能力接入后开放（M3）。"
    },
    sessions: {
      title: "会话",
      desc: "聊天优先的工作台将在 M1 里程碑交付：左侧会话列表、中央聊天区与原始终端抽屉。"
    },
    runs: {
      title: "运行历史",
      desc: "Project Run 与 AgentRun 的时间线、验收与恢复将在 M3 里程碑开放。"
    }
  }
};

export type Messages = typeof zh;

const en: Messages = {
  app: {
    name: "AgentHub",
    tagline: "Local multi-agent coding workbench",
    skipToContent: "Skip to main content",
    browserBadge: "Browser preview",
    windowMinimize: "Minimize",
    windowMaximize: "Maximize",
    windowRestore: "Restore",
    windowClose: "Close"
  },
  nav: {
    section: "Workbench",
    projects: "Projects",
    agents: "Agents",
    teams: "Teams",
    tasks: "Tasks",
    sessions: "Sessions",
    runs: "Runs",
    settings: "Settings"
  },
  common: {
    add: "Add",
    create: "New",
    edit: "Edit",
    save: "Save",
    cancel: "Cancel",
    remove: "Remove",
    close: "Close",
    confirm: "Confirm",
    browse: "Browse…",
    retry: "Retry",
    back: "Back",
    optional: "Optional",
    none: "None",
    enabled: "Enabled",
    disabled: "Disabled",
    loading: "Loading…",
    unknown: "Unknown",
    notConfigured: "Not configured",
    count: "{count} items"
  },
  status: {
    agent: {
      offline: "Offline",
      available: "Available",
      running: "Running",
      waiting_input: "Waiting for input",
      waiting_approval: "Waiting for approval",
      error: "Error",
      disabled: "Disabled"
    },
    provider: {
      ready: "Ready",
      missing: "Not detected",
      outdated: "Outdated",
      error: "Detection failed"
    },
    run: {
      planning: "Planning",
      executing: "Executing",
      verifying: "Verifying",
      waiting_user: "Waiting for user"
    },
    git: {
      clean: "Working tree clean",
      dirty: "{count} uncommitted changes"
    }
  },
  capabilities: {
    headless_structured: "Structured output",
    headless_text: "Text output",
    long_running_stdin: "Long-running stdin",
    pty_interactive: "Interactive PTY",
    provider_server: "Local server"
  },
  taskTypes: {
    code: "Coding",
    refactor: "Refactor",
    review: "Review",
    test: "Testing",
    docs: "Docs",
    debug: "Debug",
    plan: "Planning",
    research: "Research"
  },
  strengthAreas: {
    coding: "Code generation",
    refactor: "Refactoring",
    review: "Code review",
    testing: "Testing",
    docs: "Documentation",
    debug: "Debugging",
    planning: "Planning",
    research: "Research"
  },
  envPolicies: {
    "env-standard": {
      name: "Standard whitelist",
      description: "Only the minimal env vars a provider needs"
    },
    "env-strict": {
      name: "Strict isolation",
      description: "Nothing inherited; every variable declared"
    },
    "env-custom": {
      name: "Custom",
      description: "Use a user-defined environment whitelist"
    }
  },
  risk: {
    level: {
      info: "Info",
      warning: "Warning",
      critical: "Critical"
    },
    texts: {
      dirtyWorktree: "Uncommitted changes detected; use isolated worktrees for parallel tasks",
      noGit: "Not a Git repository; team delegation unavailable, single-agent mode only",
      nodeVersionMismatch: "Multiple Node version manager configs detected; environment may be inconsistent",
      unpinnedDeps: "Some dependencies are not version-locked; builds may not be reproducible",
      largeRepo: "Large repository; first indexing and scans may be slow",
      noTestCommand: "No test command detected; register acceptance command templates first"
    }
  },
  projects: {
    title: "Projects",
    subtitle: "Manage local projects and their runs",
    count: "{count} projects",
    add: "Add project",
    addTitle: "Add a local project",
    addDesc: "Pick a local directory and AgentHub scans its Git state, tech stack and layout.",
    pathLabel: "Project directory",
    pathPlaceholder: "e.g. C:\\work\\my-project",
    nameLabel: "Display name",
    namePlaceholder: "Defaults to the directory name",
    browserPickerHint: "The system directory picker is unavailable in browser preview; type the path manually.",
    scanning: "Scanning project…",
    scanHint: "Scanning is read-only and never modifies the directory",
    remove: "Remove project",
    removeTitle: "Remove project",
    removeDesc: "Only removes the configuration of “{name}” from AgentHub. Nothing on disk is deleted.",
    addedToast: "Project “{name}” added",
    removedToast: "Project “{name}” removed",
    duplicateToast: "This directory is already in the project list",
    rescanDoneToast: "“{name}” scan finished",
    empty: {
      title: "No projects yet",
      desc: "Add a local directory as a workspace and start working with agents.",
      action: "Add your first project"
    },
    card: {
      activeRun: "Active run",
      lastOpened: "Opened {time}",
      noScan: "Not scanned yet",
      rescan: "Rescan"
    },
    detail: {
      back: "Back to projects",
      gitTitle: "Git repository",
      stackTitle: "Tech stack",
      pathsTitle: "Directory mapping",
      risksTitle: "Risks",
      runTitle: "Active run",
      branch: "Current branch",
      defaultBranch: "Default branch",
      remote: "Remote",
      worktree: "Working tree",
      noGit: "Not a Git repository",
      frontendPaths: "Frontend paths",
      backendPaths: "Backend paths",
      noPaths: "No explicit frontend/backend directories detected",
      noRisks: "No risks detected. The project looks healthy.",
      confidence: "{value}% confidence",
      goal: "Goal",
      agent: "Running agent",
      startedAt: "Started {time}",
      notScanned: "This project has not been scanned yet.",
      scanNow: "Scan now"
    }
  },
  agents: {
    title: "Agents",
    subtitle: "Manage CLI detection and agent instance configuration",
    tabs: {
      instances: "Instances",
      providers: "Provider detection"
    },
    instances: {
      desc: "An instance defines which CLI, model and arguments an agent runs with.",
      new: "New agent",
      emptyTitle: "No agent instances yet",
      emptyDesc: "Create an instance binding a provider, a model and capability config.",
      emptyAction: "Create your first agent",
      updatedAt: "Updated {time}",
      disableHint: "Disabled agents are never delegated to",
      enableHint: "Enabled agents can join teams and delegation",
      model: "Model",
      args: "Args",
      defaultModel: "Provider default",
      apiKeySet: "API key set",
      edit: "Edit instance"
    },
    editor: {
      createTitle: "New agent instance",
      editTitle: "Edit agent instance",
      basic: {
        name: "Instance name",
        namePlaceholder: "e.g. codex-main",
        provider: "Provider",
        providerPlaceholder: "Select a CLI provider",
        model: "Model",
        modelPlaceholder: "e.g. gpt-5-codex",
        modelHint: "Leave empty to use the provider default",
        modelLoading: "Loading available models from the local CLI…",
        modelLoaded: "Loaded {count} models from the local CLI; default: {default}",
        modelCustom: "This custom model ID will be passed to the CLI unchanged.",
        modelDefault: "Default",
        modelDefaultPlaceholder: "Leave blank to use {model}",
        refreshModels: "Refresh models",
        reasoning: "Reasoning effort",
        reasoningDefault: "Use model default",
        reasoningHint: "Effort levels reported by the local CLI for {model}",
        reasoningUnavailable: "Choose a model to load effort levels from the local CLI",
        args: "Startup arguments",
        argsPlaceholder: "Type an argument and press Enter, e.g. --full-auto",
        argsHint: "Passed to the CLI as baseArgs, in order",
        profile: "Profile",
        profilePlaceholder: "e.g. default",
        envPolicy: "Environment policy",
        enabled: "Enable this instance",
        enabledHint: "Disabled agents are never delegated to",
        credentials: "Credentials & endpoint (optional)",
        apiKey: "API key",
        apiKeyPlaceholder: "sk-...",
        apiKeyHint: "Stored locally only; injected into the CLI env at runtime",
        baseUrl: "API base URL",
        baseUrlPlaceholder: "https://api.example.com/v1",
        baseUrlHint: "For third-party relay/proxy services; empty uses the default endpoint",
        showKey: "Show API key",
        hideKey: "Hide API key"
      },
      savedToast: "“{name}” saved",
      createdToast: "“{name}” created",
      nameRequired: "Please enter an instance name",
      providerRequired: "Please select a provider"
    },
    providers: {
      desc: "Installation and availability of local CLIs.",
      notice: "Only local CLI detection is shown. Sign-in and authorization stay with each CLI — AgentHub never brokers third-party accounts.",
      executable: "Executable",
      version: "Version",
      minVersion: "Requires ≥ {version}",
      capabilities: "Capabilities",
      checkedAt: "Checked {time}",
      redetect: "Re-detect",
      redetecting: "Detecting…",
      redetectDone: "{name} detection finished",
      missingHint: "Executable not found on PATH. Install it, then re-detect.",
      errorHint: "Detection failed unexpectedly. Make sure the CLI runs correctly.",
      outdatedHint: "Below the minimum supported version. Upgrade and re-detect."
    }
  },
  settings: {
    title: "Settings",
    subtitle: "Appearance, language and UI preferences",
    appearance: {
      title: "Appearance",
      desc: "Pick a theme; the preference is stored locally",
      dark: "Dark",
      light: "Light",
      system: "System"
    },
    language: {
      title: "Language",
      desc: "Switch the interface language",
      zh: "简体中文",
      en: "English"
    },
    motion: {
      title: "Motion",
      desc: "Reduce transitions and animations (follows the OS by default)",
      reduce: "Reduce motion"
    },
    nav: {
      title: "Navigation modules",
      desc: "Choose which modules appear in the sidebar; Projects, Agents and Settings are always shown",
      locked: "Pinned"
    },
    about: {
      title: "About",
      appVersion: "App version",
      runtime: "Runtime",
      platform: "Platform",
      mode: "Mode",
      modeElectron: "Electron desktop",
      modeBrowser: "Browser preview (Core unavailable)",
      dataNote: "In Electron, projects, agents, teams, sessions, and runs come from Core Daemon and local SQLite. Browser preview does not fabricate business data."
    }
  },
  teams: {
    title: "Teams",
    subtitle: "User-defined members, roles and delegation policy",
    new: "New team",
    count: "{count} teams",
    empty: {
      title: "No teams yet",
      desc: "Create a team to compose your agent instances into a delegable crew.",
      action: "Create your first team"
    },
    card: {
      members: "{count} members",
      main: "Main agent",
      delegatePool: "Sub-agent pool",
      updatedAt: "Updated {time}",
      untitled: "Untitled team"
    },
    editor: {
      back: "Back to teams",
      nameLabel: "Team name",
      namePlaceholder: "e.g. Strike team",
      deleteTeam: "Delete team",
      deleteTitle: "Delete team",
      deleteDesc: "Only removes the team “{name}”. Agent instances and projects are untouched.",
      deletedToast: "Team “{name}” deleted",
      policyTitle: "Delegation policy",
      policyDesc: "Controls when the main agent may delegate",
      membersTitle: "Members",
      membersDesc: "Members are fully user-defined — nothing appears unless you create it",
      addMember: "Add member",
      mainBadge: "Main agent",
      setMain: "Set as main",
      mainRunningNote: "A session is running; the main-agent change takes effect on the next run.",
      remove: "Remove member",
      removeTitle: "Remove member",
      removeDesc: "Removes “{name}” from the team. The bound agent instance is untouched.",
      validationTitle: "Team validation"
    },
    member: {
      nameLabel: "Member name",
      namePlaceholder: "e.g. Alex",
      instanceLabel: "Bound instance",
      instancePlaceholder: "Select an agent instance",
      maxConcurrent: "Max concurrent tasks",
      taskTypes: "Accepted task types",
      customTaskTypePlaceholder: "Custom task type, press Enter",
      enabled: "Enable member",
      enabledHint: "Disabled members are never delegated to",
      createTitle: "Add member",
      editTitle: "Edit member",
      tabs: { basic: "Basics", role: "Role" }
    },
    role: {
      name: "Role name",
      namePlaceholder: "e.g. Captain",
      description: "Role description",
      descriptionPlaceholder: "What this role does and does not do",
      responsibilities: "Responsibilities",
      responsibilitiesPlaceholder: "e.g. Break down goals, press Enter",
      strengths: "Strengths",
      strengthsHint: "Free-text areas rated 1–5",
      addStrength: "Add area",
      areaPlaceholder: "Type or pick an area",
      limitations: "Limitations",
      limitationsPlaceholder: "e.g. no database migrations, press Enter",
      systemInstructions: "System instructions",
      systemInstructionsPlaceholder: "Extra instructions injected into this member's sessions (optional)"
    },
    policy: {
      autonomous: "Autonomous",
      autonomousDesc: "The main agent decides on its own whether to delegate",
      ask_before_delegate: "Ask before delegating",
      ask_before_delegateDesc: "Proposed delegations wait for your approval",
      direct_only: "Main agent only",
      direct_onlyDesc: "Delegation disabled; the main agent does everything"
    },
    validation: {
      noMembers: "The team has no members and cannot run",
      noEnabled: "Every member is disabled; no one can act as main agent",
      mainMissing: "No main agent selected",
      mainDisabled: "Main agent “{name}” is disabled",
      duplicateInstance: "Members {names} share the same instance",
      instanceMissing: "Member “{name}” is bound to a deleted instance",
      instanceDisabled: "Member “{name}” is bound to disabled instance “{instance}”",
      memberDisabled: "Member “{name}” is disabled and will not be delegated to",
      ok: "Validation passed — the team is ready"
    }
  },
  sessions: {
    title: "Sessions",
    new: "New session",
    newTitle: "New session",
    newDesc: "Pick a project and a chat target (a team or a single agent).",
    projectLabel: "Project",
    targetLabel: "Chat target",
    cliLabel: "Main-session CLI",
    cliPlaceholder: "Choose the agent instance for this conversation",
    delegateTeamLabel: "Delegation team (optional)",
    delegateTeamHint: "Teams only provide sub-agents; the selected CLI remains the main agent",
    noDelegateTeam: "No team",
    noDelegateTeamHint: "The selected CLI completes this conversation directly",
    titleLabel: "Title",
    titlePlaceholder: "Generated from the first message by default",
    empty: {
      title: "No sessions yet",
      desc: "Create a session to start chatting with an agent or a team.",
      action: "New session"
    },
    noSelection: "Select or create a session to start chatting",
    targets: { team: "Team", agent: "Single agent", member: "Member" },
    panel: {
      title: "Agent assignment",
      mainBadge: "Main",
      mainSession: "Main session",
      subSessions: "Sub-agent sessions",
      noSub: "Main agent worked directly — no sub-agent sessions",
      noTasks: "No delegated tasks",
      directNote: "No subtasks shown while the main agent works directly",
      tasksTitle: "Tasks",
      openSession: "Open session",
      policy: "Delegation policy",
      editTeam: "Edit team",
      single: "Single-agent session",
      instanceInfo: "Current instance"
    },
    composer: {
      placeholder: "Message {name}…",
      send: "Send",
      stop: "Stop",
      hint: "Enter to send, Shift+Enter for newline",
      advanced: "Advanced",
      speed: "Speed",
      standard: "Standard",
      fast: "Fast",
      fastUnavailable: "Fast mode is unavailable for this model"
    },
    header: {
      dag: "Task DAG",
      artifacts: "Diff / Artifacts",
      terminal: "Raw terminal",
      untitled: "Untitled session"
    },
    cards: {
      command: "Command",
      exitCode: "Exit {code}",
      output: "Output",
      running: "Running",
      verification: "Verification",
      passed: "Passed",
      failed: "Failed",
      duration: "{seconds}s",
      log: "Log",
      approval: "Approval request",
      approve: "Approve",
      reject: "Reject",
      scope: "Scope",
      scopeOnce: "Once",
      scopeRun: "This run",
      scopeTask: "This task",
      scopeProject: "This project",
      scopeGlobal: "Global",
      approved: "Approved",
      rejected: "Rejected",
      decision: { direct: "Direct", delegate: "Delegate", plan: "Plan" },
      handoff: "Context handoff",
      openSub: "Open sub-session",
      error: "Error",
      retryable: "Retryable",
      notRetryable: "Not retryable",
      files: "{count} files",
      viewDiff: "View diff",
      taskAssigned: "Task assigned"
    },
    drawers: {
      terminal: "Raw terminal",
      terminalNote: "PTY/debug fallback only — not a replacement for chat",
      terminalEmpty: "No raw output in this session yet",
      artifacts: "Diff & artifacts",
      noArtifacts: "No artifacts in this session yet",
      dag: "Task dependency graph",
      dagNote: "Shown only when the main agent creates a plan",
      tabs: { diff: "Diff", contract: "API contract", test: "Test report", commit: "Commits" }
    },
    status: {
      idle: "Idle",
      running: "Running",
      waiting_input: "Waiting for input",
      waiting_approval: "Waiting for approval",
      completed: "Completed",
      failed: "Failed",
      archived: "Archived"
    },
    taskStatus: {
      draft: "Draft",
      ready: "Ready",
      blocked_dependency: "Blocked",
      queued: "Queued",
      running: "Running",
      waiting_user: "Waiting",
      waiting_approval: "Approval",
      verifying: "Verifying",
      review_required: "Review",
      merge_ready: "Merge ready",
      completed: "Completed",
      failed: "Failed",
      cancelled: "Cancelled"
    }
  },
  placeholder: {
    badge: "Later milestone",
    teams: {
      title: "Custom teams",
      desc: "Team builder, roles and delegation policies arrive in M2. Members are fully user-defined — no fixed roles."
    },
    tasks: {
      title: "Task board",
      desc: "Task DAGs, dependencies and status tracking open once main-agent planning lands (M3)."
    },
    sessions: {
      title: "Sessions",
      desc: "The chat-first workbench arrives in M1: session list, central chat and a raw terminal drawer."
    },
    runs: {
      title: "Run history",
      desc: "Project run and agent run timelines, verification and recovery arrive in M3."
    }
  }
};

export const dictionaries: Record<LocaleCode, Messages> = {
  "zh-CN": zh,
  "en-US": en
};

type DotPaths<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : DotPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type MessageKey = DotPaths<Messages>;

function resolve(dict: Messages, key: string): string | undefined {
  let node: unknown = dict;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

function interpolate(template: string, values?: Record<string, string | number>): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match
  );
}

export interface I18n {
  locale: LocaleCode;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }): JSX.Element {
  const locale = useSettingsStore((state) => state.locale);

  const t = useCallback(
    (key: MessageKey, values?: Record<string, string | number>) => {
      const template = resolve(dictionaries[locale], key) ?? resolve(zh, key) ?? key;
      return interpolate(template, values);
    },
    [locale]
  );

  const value = useMemo(() => ({ locale, t }), [locale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
