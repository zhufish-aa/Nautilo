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
const playGlyph = playButton.firstElementChild;
const runPosition = document.getElementById("run-position");
const runStops = document.querySelectorAll("[data-run-stop]");
const runEvidence = document.querySelectorAll(".run-evidence > article");
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
  const finished = runStep === Number(runPosition.max);
  const playing = runTimer !== undefined;
  const message = runMessages[runStep + 1][english ? 1 : 0];
  workflowStatus.textContent = message;
  runPosition.value = Math.max(0, runStep);
  runPosition.setAttribute("aria-valuetext", message);

  playGlyph.textContent = playing ? "Ⅱ" : "▷";
  if (playing) playLabel.textContent = english ? "Pause" : "暂停";
  else if (finished) playLabel.textContent = english ? "Replay run" : "重新播放";
  else if (runStep >= 0) playLabel.textContent = english ? "Resume" : "继续播放";
  else playLabel.textContent = english ? "Play run" : "播放执行";

  for (const [index, stop] of runStops.entries()) {
    if (index === runStep) stop.setAttribute("aria-current", "step");
    else stop.removeAttribute("aria-current");
  }
  for (const [index, evidence] of runEvidence.entries()) {
    evidence.hidden = index !== runStep + 1;
  }
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
  if (tab.id !== "workflow-tab" && runTimer !== undefined) stopRun();
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
    const active = index === step;
    node.dataset.run = index < step ? "done" : active ? "active" : "idle";
    node.setAttribute("aria-pressed", String(active));
  }
  renderRun();
}

function stopRun() {
  clearTimeout(runTimer);
  runTimer = undefined;
  renderRun();
}

function playRun(step) {
  const lastStep = Number(runPosition.max);
  runTimer = step === lastStep ? undefined : setTimeout(() => playRun(step + 1), 1400);
  paintRun(step);
}

function seekRun(step) {
  clearTimeout(runTimer);
  runTimer = undefined;
  paintRun(step);
}

playButton.addEventListener("click", () => {
  if (runTimer !== undefined) {
    stopRun();
    return;
  }
  playRun(runStep < 0 || runStep === Number(runPosition.max) ? 0 : runStep);
});
runPosition.addEventListener("input", () => seekRun(Number(runPosition.value)));
for (const [index, stop] of runStops.entries()) {
  stop.addEventListener("click", () => seekRun(index));
}
for (const node of workflowNodes) {
  node.setAttribute("aria-pressed", "false");
  node.addEventListener("click", () => seekRun(Number(node.dataset.step)));
}

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const engraving = document.getElementById("engraving");
const engravingDetail = engraving.querySelector(".engraving-detail");
const engravingTexture = engravingDetail.querySelector("img");
const engravingToggle = document.querySelector(".engraving-toggle");
let engravingFrame;

function placeDetail(x, y) {
  const zoom = 1.62;
  const radius = engravingDetail.clientWidth / 2;
  const left = Math.max(0, Math.min(engraving.clientWidth - radius * 2, x - radius));
  const top = Math.max(0, Math.min(engraving.clientHeight - radius * 2, y - radius));
  engravingTexture.style.width = engraving.clientWidth * zoom + "px";
  engravingTexture.style.height = engraving.clientHeight * zoom + "px";
  engravingTexture.style.transform = `translate3d(${radius - x * zoom}px, ${radius - y * zoom}px, 0)`;
  engravingDetail.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  engravingDetail.setAttribute("data-visible", "");
}

function moveDetail(event) {
  cancelAnimationFrame(engravingFrame);
  engravingFrame = requestAnimationFrame(() => {
    const rect = engraving.getBoundingClientRect();
    placeDetail(event.clientX - rect.left, event.clientY - rect.top);
  });
}

function hideDetail() {
  cancelAnimationFrame(engravingFrame);
  engravingDetail.removeAttribute("data-visible");
}

engravingToggle.hidden = false;
engravingToggle.addEventListener("click", () => {
  const enabled = engravingToggle.getAttribute("aria-pressed") !== "true";
  engravingToggle.setAttribute("aria-pressed", String(enabled));
  if (enabled) placeDetail(engraving.clientWidth * .47, engraving.clientHeight * .51);
  else hideDetail();
});
engraving.addEventListener("pointermove", event => {
  if (event.pointerType === "mouse" && !reducedMotion.matches) moveDetail(event);
});
engraving.addEventListener("pointerdown", event => {
  if (engravingToggle.getAttribute("aria-pressed") === "true") moveDetail(event);
});
engraving.addEventListener("pointerleave", () => {
  if (engravingToggle.getAttribute("aria-pressed") !== "true") hideDetail();
});
window.addEventListener("resize", () => {
  if (engravingToggle.getAttribute("aria-pressed") === "true") {
    placeDetail(engraving.clientWidth * .47, engraving.clientHeight * .51);
  } else hideDetail();
});
reducedMotion.addEventListener("change", () => {
  if (engravingToggle.getAttribute("aria-pressed") !== "true") hideDetail();
});

const gitDemo = document.querySelector(".git-specimen");
const gitFrames = gitDemo.querySelectorAll(".code-removed, .code-added, .git-result > span");
const gitReplay = gitDemo.querySelector(".git-replay");

function stopGitDemo() {
  for (const frame of gitFrames) {
    for (const animation of frame.getAnimations()) animation.cancel();
  }
}

gitReplay.hidden = false;
gitReplay.addEventListener("click", () => {
  stopGitDemo();
  gitDemo.querySelector('[value="diff"]').checked = true;
  if (reducedMotion.matches) return;
  const easing = getComputedStyle(root).getPropertyValue("--ease").trim();
  for (const [index, frame] of gitFrames.entries()) {
    frame.animate(
      [{ opacity: 0, transform: "translateX(-5px)" }, { opacity: 1, transform: "translateX(0)" }],
      { duration: 260, delay: [0, 260, 650, 1000][index], easing, fill: "backwards" },
    );
  }
});
gitDemo.querySelector(".patch-modes").addEventListener("change", stopGitDemo);
reducedMotion.addEventListener("change", stopGitDemo);

const mobileScene = document.querySelector(".mobile-visual");
const mobileReplay = mobileScene.querySelector(".mobile-replay");
const mobileFrames = [
  mobileScene.querySelector(".phone-bubble"),
  mobileScene.querySelector(".mobile-incoming"),
  mobileScene.querySelector(".mobile-desktop-review"),
  mobileScene.querySelector(".phone-answer"),
];

function stopMobileReplay() {
  for (const frame of mobileFrames) {
    for (const animation of frame.getAnimations()) animation.cancel();
  }
}

mobileReplay.hidden = false;
mobileReplay.addEventListener("click", () => {
  stopMobileReplay();
  if (reducedMotion.matches) return;
  const easing = getComputedStyle(root).getPropertyValue("--ease").trim();
  for (const [index, frame] of mobileFrames.entries()) {
    frame.animate(
      [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }],
      { duration: 260, delay: index * 350, easing, fill: "backwards" },
    );
  }
});
reducedMotion.addEventListener("change", stopMobileReplay);

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
