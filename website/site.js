const root = document.documentElement;
const languageButton = document.getElementById("language");
const themeButton = document.getElementById("theme");
const releaseVersion = document.getElementById("release-version");
const primaryDownload = document.getElementById("primary-download");
const primaryLabel = document.getElementById("primary-label");
const platform = navigator.userAgentData?.platform || navigator.userAgent;
const desktopPlatform = /Android|iPhone|iPad/i.test(navigator.userAgent) ? null
  : /Win/i.test(platform) ? "windows"
  : /Linux/i.test(platform) ? "linux"
  : /Mac/i.test(platform) ? "mac"
  : null;
const primaryAsset = desktopPlatform === "mac" ? null : desktopPlatform;

const translations = Array.from(document.querySelectorAll("[data-en]"), element => [element, element.textContent]);
const accessibleLabels = Array.from(document.querySelectorAll("[data-aria-en]"), element => [element, element.getAttribute("aria-label")]);
const workflowNodes = Array.from(document.querySelectorAll(".flow-node"));
const workflowStatus = document.getElementById("workflow-status");
const playButton = document.getElementById("play-workflow");
const playLabel = playButton.querySelector("[data-en]");
const runMessages = [
  ["等待播放", "Ready to preview"],
  ["主 Agent 派发任务", "Lead agent assigns work"],
  ["两个 Agent 并行执行", "Two agents are working in parallel"],
  ["汇合两路结果", "Joining both results"],
  ["独立复核改动与测试", "Reviewing the code and tests"],
  ["将结果交回主会话", "Returning results to the conversation"],
  ["执行完成 · 结果已回到主会话", "Run complete · Results returned to the conversation"],
];

let releaseTag = "";
let runStep = -1;
let runTimer;

function render() {
  const english = root.lang === "en";
  for (const [element, chinese] of translations) element.textContent = english ? element.dataset.en : chinese;
  for (const [element, chinese] of accessibleLabels) element.setAttribute("aria-label", english ? element.dataset.ariaEn : chinese);

  document.title = english ? "Nautilo · Local multi-agent coding workspace" : "Nautilo · 多 Agent 编程工作台";
  languageButton.textContent = english ? "中文" : "EN";
  languageButton.lang = english ? "zh-CN" : "en";
  languageButton.setAttribute("aria-label", english ? "切换简体中文" : "Switch to English");
  const dark = root.dataset.theme === "dark";
  themeButton.setAttribute("aria-label", english
    ? (dark ? "Switch to light mode" : "Switch to dark mode")
    : (dark ? "切换浅色模式" : "切换深色模式"));

  if (releaseTag) releaseVersion.textContent = releaseTag;
  if (primaryAsset && primaryDownload.getAttribute("href") !== "#download") {
    const name = primaryAsset === "windows" ? "Windows" : "Linux";
    primaryLabel.textContent = english ? `Download for ${name}` : `下载 ${name} 版`;
  }
  renderRun();
}

function renderRun() {
  const english = root.lang === "en";
  workflowStatus.textContent = runMessages[runStep + 1][english ? 1 : 0];
  if (runStep >= 0) playLabel.textContent = english ? "Replay run" : "重新播放";
}

const preference = new URLSearchParams(location.search).get("lang") || localStorage.getItem("nautilo-site-language");
root.lang = preference === "en" ? "en" : "zh-CN";
root.dataset.theme = localStorage.getItem("nautilo-site-theme") === "light" ? "light" : "dark";
render();

const header = document.querySelector(".site-header");
function updateHeader() {
  header.toggleAttribute("data-scrolled", window.scrollY > 16);
}
updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

if (desktopPlatform) {
  const badge = document.getElementById("platform-current");
  document.querySelector(`[data-platform="${desktopPlatform}"] strong`).append(badge);
  badge.hidden = false;
}

languageButton.addEventListener("click", () => {
  root.lang = root.lang === "en" ? "zh-CN" : "en";
  localStorage.setItem("nautilo-site-language", root.lang);
  const url = new URL(location.href);
  if (url.searchParams.has("lang") && location.protocol !== "file:") {
    url.searchParams.set("lang", root.lang);
    history.replaceState(null, "", url);
  }
  render();
});

themeButton.addEventListener("click", () => {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("nautilo-site-theme", root.dataset.theme);
  render();
});

const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
function selectTab(tab) {
  for (const item of tabs) {
    const active = item === tab;
    item.setAttribute("aria-selected", String(active));
    item.tabIndex = active ? 0 : -1;
    document.getElementById(item.getAttribute("aria-controls")).hidden = !active;
  }
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", event => {
    const next = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectTab(tabs[next]);
    tabs[next].focus();
  });
}
for (const [selector, id] of [["[data-open-session]", "session-tab"], ["[data-open-workflow]", "workflow-tab"]]) {
  for (const link of document.querySelectorAll(selector)) {
    link.addEventListener("click", () => {
      const tab = document.getElementById(id);
      selectTab(tab);
      tab.focus({ preventScroll: true });
    });
  }
}

function paintRun(step) {
  runStep = step;
  for (const node of workflowNodes) {
    const index = Number(node.dataset.step);
    node.dataset.run = index < step ? "done" : index === step ? "active" : "idle";
  }
  renderRun();
  if (step + 2 < runMessages.length) runTimer = setTimeout(() => paintRun(step + 1), 850);
}
playButton.addEventListener("click", () => {
  clearTimeout(runTimer);
  paintRun(0);
});

const gitDemo = document.querySelector(".git-specimen");
const gitFrames = gitDemo.querySelectorAll(".code-line, .git-result > span");
const gitReplay = gitDemo.querySelector(".git-replay");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function setupShellMotion() {
  if (!CSS.supports("offset-path", 'path("M 0 0 L 1 1")')) return;

  // The path coordinates follow the 1536 × 1024 engraving.
  const plate = document.querySelector(".hero-plate");
  const art = plate.querySelector(".hero-art");
  const replay = plate.querySelector(".hero-replay");
  const overlay = document.createElement("div");
  const map = document.createElement("div");
  const canvas = document.createElement("canvas");
  const junction = document.createElement("span");
  canvas.width = 1536;
  canvas.height = 1024;
  const context = canvas.getContext("2d");
  if (!context) return;
  overlay.className = "hero-traces";
  overlay.setAttribute("aria-hidden", "true");
  map.className = "hero-trace-map";
  junction.className = "hero-junction";
  overlay.append(map);
  map.append(canvas, junction);
  art.after(overlay);

  const routes = [
    { stage: "conversation", color: "--flow-lead", delay: 250, duration: 780,
      path: "M 206 345 C 260 298 325 273 383 278 C 437 280 470 307 483 340 C 523 333 558 358 594 391" },
    { stage: "plan", color: "--flow-join", delay: 1030, duration: 1010,
      path: "M 594 391 C 610 377 601 363 582 359 C 587 336 568 312 548 302 C 593 293 627 264 623 212 C 619 156 566 93 498 73 C 681 12 824 112 850 271 C 855 299 856 320 883 324" },
    { stage: "plan", color: "--flow-explore", delay: 1030, duration: 1010,
      path: "M 594 391 C 568 399 559 414 542 424 C 501 451 508 509 534 539 C 614 603 738 568 797 505 C 834 459 850 379 883 324" },
    { stage: "review", color: "--flow-return", delay: 2040, duration: 900,
      path: "M 883 324 C 958 305 990 266 1092 247 C 1192 226 1298 250 1360 302 C 1397 347 1366 493 1326 586" },
  ].map(route => {
    const tracer = document.createElement("span");
    tracer.className = "hero-trace";
    tracer.style.setProperty("--trace-color", `var(${route.color})`);
    tracer.style.offsetPath = `path("${route.path}")`;
    map.append(tracer);
    return { ...route, tracer, shape: new Path2D(route.path) };
  });

  const resize = new ResizeObserver(() => {
    map.style.transform = `scale(${plate.clientWidth / canvas.width})`;
  });
  resize.observe(plate);
  const stop = () => {
    for (const animation of overlay.getAnimations({ subtree: true })) animation.cancel();
  };
  const play = (stage) => {
    if (reducedMotion.matches || !art.naturalWidth) return;
    intro.disconnect();
    stop();
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.lineCap = "round";
    context.lineWidth = 3;
    context.globalAlpha = .44;
    const colors = getComputedStyle(root);
    let end = 0;
    for (const route of routes) {
      if (stage && route.stage !== stage) continue;
      const delay = stage ? 0 : route.delay;
      context.strokeStyle = colors.getPropertyValue(route.color).trim();
      context.stroke(route.shape);
      route.tracer.animate(
        [{ offsetDistance: "0%", opacity: 0 }, { opacity: 1, offset: .14 }, { opacity: 1, offset: .85 }, { offsetDistance: "100%", opacity: 0 }],
        { delay, duration: route.duration, easing: "linear" },
      );
      if (route.stage === "review") {
        junction.animate([{ transform: "scale(.92)", opacity: .85 }, { transform: "scale(2)", opacity: 0 }],
          { delay, duration: 450, easing: colors.getPropertyValue("--ease").trim() });
      }
      end = Math.max(end, delay + route.duration);
    }
    canvas.animate([{ opacity: 0 }, { opacity: 1, offset: .18 }, { opacity: 1, offset: .82 }, { opacity: 0 }],
      { duration: end + 220, easing: "linear" });
  };
  const intro = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    intro.disconnect();
    play();
  }, { threshold: .5 });
  if (art.complete) intro.observe(plate);
  else art.addEventListener("load", () => intro.observe(plate), { once: true });
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  for (const link of plate.querySelectorAll(".hero-map a")) {
    link.addEventListener("pointerenter", (event) => {
      if (finePointer.matches && event.pointerType === "mouse") play(link.dataset.stage);
    });
    link.addEventListener("focus", () => {
      if (link.matches(":focus-visible")) play(link.dataset.stage);
    });
  }
  replay.hidden = false;
  replay.addEventListener("click", () => play());
  themeButton.addEventListener("click", stop);
  reducedMotion.addEventListener("change", stop);
}

setupShellMotion();

function stopGitDemo() {
  for (const frame of gitFrames) {
    for (const animation of frame.getAnimations()) animation.cancel();
  }
}

function playGitDemo() {
  stopGitDemo();
  if (reducedMotion.matches) return;
  const easing = getComputedStyle(root).getPropertyValue("--ease").trim();
  let delay = 0;
  for (const frame of gitFrames) {
    frame.animate(
      [{ opacity: .08, transform: "translateX(-4px)" }, { opacity: 1, transform: "translateX(0)" }],
      { duration: 250, delay, easing, fill: "backwards" },
    );
    delay += frame.matches(".code-removed, .git-command") ? 250 : 85;
  }
}

const gitObserver = new IntersectionObserver(([entry]) => {
  if (!entry.isIntersecting) return;
  gitObserver.disconnect();
  playGitDemo();
}, { threshold: .08 });
gitObserver.observe(gitDemo.querySelector(".git-code"));
gitReplay.hidden = false;
gitReplay.addEventListener("click", () => {
  gitObserver.disconnect();
  playGitDemo();
});
reducedMotion.addEventListener("change", stopGitDemo);

const revealTargets = document.querySelectorAll("[data-reveal], .specimen-state i, .mobile-visual figcaption .connection-dot");
const revealObserver = new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) {
    if (!isIntersecting) continue;
    revealObserver.unobserve(target);
    if (reducedMotion.matches) continue;
    if (target.hasAttribute("data-reveal")) {
      target.animate(
        [{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "translateY(0)" }],
        { duration: 500, easing: getComputedStyle(root).getPropertyValue("--ease").trim() },
      );
    } else {
      target.animate([{ opacity: 1 }, { opacity: .62 }, { opacity: 1 }], { duration: 1500, iterations: 3 });
    }
  }
}, { threshold: .08 });
for (const target of revealTargets) revealObserver.observe(target);
reducedMotion.addEventListener("change", () => {
  if (!reducedMotion.matches) return;
  for (const target of revealTargets) {
    for (const animation of target.getAnimations()) animation.cancel();
  }
});

const installers = {
  windows: /-win-x64\.exe$/i,
  "mac-arm": /-mac-arm64\.dmg$/i,
  "mac-intel": /-mac-x64\.dmg$/i,
  linux: /-linux-x86_64\.AppImage$/i,
};

async function loadRelease() {
  try {
    const response = await fetch("https://api.github.com/repos/zhufish-aa/Nautilo/releases/latest");
    if (!response.ok) return;
    const release = await response.json();
    releaseTag = release.tag_name;
    for (const link of document.querySelectorAll("[data-asset]")) {
      const kind = link.dataset.asset;
      const asset = release.assets.find(item => installers[kind].test(item.name));
      if (!asset) continue;
      link.href = asset.browser_download_url;
      if (kind === primaryAsset) primaryDownload.href = asset.browser_download_url;
    }
    render();
  } catch {
    // Keep the GitHub Releases links when its API is unavailable.
  }
}
loadRelease();
