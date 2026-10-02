import type { BrowserWindow, MessageBoxReturnValue } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { arch, hostname, platform, release, type, version as osVersion } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LOCALE,
  type Locale,
  PRODUCT_IDENTITY,
  ZCODE_BUILD_TIME,
  ZCODE_COMMIT,
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  ZCODE_VERSION,
} from "@zcode/shared";
import { createCustomAboutDialogHtml } from "./aboutWindow.js";

interface DesktopBuildMetadata {
  appVersion?: string;
  buildCommitId?: string;
  buildTime?: string;
  electronBuilderVersion?: string;
}

interface AboutSnapshot {
  appVersion: string;
  buildCommitId: string;
  buildTime: string;
  environment: string;
  electronVersion: string;
  electronBuilderVersion: string;
  chromiumVersion: string;
  nodeVersion: string;
  v8Version: string;
  osType: string;
  osPlatform: string;
  osRelease: string;
  osVersion: string;
  osArch: string;
  hostname: string;
}

interface AboutSnapshotOptions {
  appVersion?: string;
  buildMetadata?: DesktopBuildMetadata | null;
  environment?: string;
  runtimeVersions?: Pick<NodeJS.ProcessVersions, "electron" | "chrome" | "node" | "v8">;
  osInfo?: {
    type: string;
    platform: string;
    release: string;
    version: string;
    arch: string;
    hostname: string;
  };
}

// Brand name comes from the single product identity source (flavor-aware).
const ABOUT_APPLICATION_NAME = `${PRODUCT_IDENTITY.appName} Desktop App`;
// 自定义 About 内容本体是 256x280；原生窗口如果同尺寸会让内容贴满透明窗口边界。
// 这里给 BrowserWindow 额外留出背景呼吸空间，避免正式 About 看起来比 demo 更局促。
const ABOUT_WINDOW_WIDTH = 256;
// 自定义 About 内容本体高度 280，BrowserWindow 额外留 32px 背景呼吸空间。
const ABOUT_CONTENT_HEIGHT = 280;
const ABOUT_WINDOW_EXTRA_HEIGHT = 32;
// TinyCode 的来源声明 + 在线服务提示各占约两行小字；官方形态不显示这两行、尺寸不变。
const TINYCODE_NOTICE_CONTENT_HEIGHT = 356;
const TINYCODE_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" aria-hidden="true">
  <defs>
    <linearGradient id="about-bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#F8FAFC"/>
      <stop offset="1" stop-color="#DBE4EE"/>
    </linearGradient>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#about-bg)"/>
  <path d="M 386 372 L 260 512 L 386 652" fill="none" stroke="#4F46E5" stroke-width="74" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M 638 372 L 764 512 L 638 652" fill="none" stroke="#4F46E5" stroke-width="74" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="462" y="462" width="100" height="100" rx="28" fill="#4F46E5"/>
</svg>`;
const ABOUT_MESSAGES: Record<
  Locale,
  {
    aboutTitle: string;
    versionLabel: string;
    okButtonLabel: string;
    optimizedForAppleSilicon: string;
    // TinyCode-only attribution / online-service lines (grokbot dmg-review items
    // 2 & 7). Kept here so the wording matches the NOTICE preamble verbatim;
    // official flavors never render them.
    sourceNotice: string;
    onlineServiceNotice: string;
    copyright: (year: number) => string;
  }
> = {
  "zh-CN": {
    aboutTitle: `关于 ${PRODUCT_IDENTITY.appName}`,
    versionLabel: "版本",
    okButtonLabel: "确定",
    optimizedForAppleSilicon: "已针对 Apple Silicon 优化。",
    sourceNotice: "基于 Z.AI 的 ZCode (Apache-2.0) 修改而成，由 1WorldCapture 维护；非 Z.AI 官方产品。",
    onlineServiceNotice: "本应用会连接 Z.AI 在线服务（登录、模型网关、配置），使用受 Z.AI 服务条款约束。",
    copyright: (year) => `版权所有 © ${year} ${PRODUCT_IDENTITY.appName}。`,
  },
  "en-US": {
    aboutTitle: `About ${PRODUCT_IDENTITY.appName}`,
    versionLabel: "version",
    okButtonLabel: "OK",
    optimizedForAppleSilicon: "Optimized for Apple Silicon.",
    sourceNotice:
      "Based on ZCode by Z.AI (Apache-2.0), maintained by 1WorldCapture. Not an official Z.AI product.",
    onlineServiceNotice:
      "Connects to Z.AI online services (sign-in, model gateway, config). Use is subject to the Z.AI terms of service.",
    copyright: (year) => `Copyright © ${year} ${PRODUCT_IDENTITY.appName}.`,
  },
};

function normalizeValue(value: string | undefined | null): string {
  if (typeof value !== "string") {
    return "unknown";
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

function normalizePackageVersion(version: string | undefined): string {
  const normalized = normalizeValue(version);
  return normalized === "unknown" ? normalized : normalized.replace(/^[^\d]*/, "") || normalized;
}

function getAboutMessages(locale: Locale): (typeof ABOUT_MESSAGES)[Locale] {
  return ABOUT_MESSAGES[locale] ?? ABOUT_MESSAGES[DEFAULT_LOCALE];
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function resolveBuildMetadataPath(): string {
  return join(import.meta.dirname, "../metadata/build-meta.json");
}

export function readBuildMetadata(
  filePath = resolveBuildMetadataPath(),
): DesktopBuildMetadata | null {
  // 之前 About 直接读取编译时注入的常量，commit/time 只能代表 tsup 那一刻。
  // 问题原因：构建和打包是分步执行的，安装包里的 about 需要的是“最终产物”的统一元数据，而不是某个编译子步骤的快照。
  // 这里优先读打包前生成的 build-meta.json；只有缺文件时才回退到编译时常量。
  return readJsonFile<DesktopBuildMetadata>(filePath);
}

function resolveElectronBuilderVersion(buildMetadata: DesktopBuildMetadata | null): string {
  if (buildMetadata?.electronBuilderVersion) {
    return normalizeValue(buildMetadata.electronBuilderVersion);
  }

  const packageJson = readJsonFile<{ devDependencies?: Record<string, string> }>(
    join(import.meta.dirname, "../../package.json"),
  );
  return normalizePackageVersion(packageJson?.devDependencies?.["electron-builder"]);
}

export function createAboutSnapshot(options: AboutSnapshotOptions = {}): AboutSnapshot {
  const buildMetadata = options.buildMetadata ?? null;
  const runtimeVersions = options.runtimeVersions ?? process.versions;
  const osInfo = options.osInfo ?? {
    type: type(),
    platform: platform(),
    release: release(),
    version: osVersion(),
    arch: arch(),
    hostname: hostname(),
  };

  return {
    appVersion: normalizeValue(options.appVersion ?? buildMetadata?.appVersion ?? ZCODE_VERSION),
    buildCommitId: normalizeValue(buildMetadata?.buildCommitId ?? ZCODE_COMMIT),
    buildTime: normalizeValue(buildMetadata?.buildTime ?? ZCODE_BUILD_TIME),
    environment: normalizeValue(options.environment ?? ZCODE_ENV),
    electronVersion: normalizeValue(runtimeVersions.electron),
    electronBuilderVersion: resolveElectronBuilderVersion(buildMetadata),
    chromiumVersion: normalizeValue(runtimeVersions.chrome),
    nodeVersion: normalizeValue(runtimeVersions.node),
    v8Version: normalizeValue(runtimeVersions.v8),
    osType: normalizeValue(osInfo.type),
    osPlatform: normalizeValue(osInfo.platform),
    osRelease: normalizeValue(osInfo.release),
    osVersion: normalizeValue(osInfo.version),
    osArch: normalizeValue(osInfo.arch),
    hostname: normalizeValue(osInfo.hostname),
  };
}

export function formatAboutDetail(snapshot: AboutSnapshot): string {
  return [
    `Version: ${snapshot.appVersion}`,
    `Commit: ${snapshot.buildCommitId}`,
    `Build Time: ${snapshot.buildTime}`,
    `Environment: ${snapshot.environment}`,
    "",
    `Electron: ${snapshot.electronVersion}`,
    `Electron Builder: ${snapshot.electronBuilderVersion}`,
    `Chromium: ${snapshot.chromiumVersion}`,
    `Node.js: ${snapshot.nodeVersion}`,
    `V8: ${snapshot.v8Version}`,
    "",
    `OS Type: ${snapshot.osType}`,
    `OS Platform: ${snapshot.osPlatform}`,
    `OS Release: ${snapshot.osRelease}`,
    `OS Version: ${snapshot.osVersion}`,
    `OS Arch: ${snapshot.osArch}`,
    `Hostname: ${snapshot.hostname}`,
  ].join("\n");
}

function formatAboutCopyright(
  year = new Date().getFullYear(),
  locale: Locale = DEFAULT_LOCALE,
): string {
  return getAboutMessages(locale).copyright(year);
}

function formatAboutOptimizationLine(
  snapshot: Pick<AboutSnapshot, "osPlatform" | "osArch">,
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (snapshot.osPlatform === "darwin" && snapshot.osArch === "arm64") {
    return getAboutMessages(locale).optimizedForAppleSilicon;
  }

  return "";
}

function resolveAboutIconPath(isPackaged: boolean): string {
  return isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(import.meta.dirname, "../../build/icon.png");
}

export async function showAboutDialog(
  parentWindow?: BrowserWindow,
  locale: Locale = DEFAULT_LOCALE,
): Promise<MessageBoxReturnValue> {
  const { app, BrowserWindow } = await import("electron");
  const snapshot = createAboutSnapshot({
    appVersion: app.getVersion(),
    buildMetadata: readBuildMetadata(),
  });
  const aboutMessages = getAboutMessages(locale);
  // Attribution / online-service lines and the flavor logo are TinyCode-only
  // (Apache-2.0 items 2 & 7 of the dmg acceptance list); official flavors keep
  // the original dialog untouched — same size, same glyph, no extra lines.
  const isTinycode = ZCODE_PRODUCT_FLAVOR === "tinycode";
  // 之前只有 macOS 使用自绘 About，Windows/Linux 仍走原生 message box。
  // 问题原因：各平台原生消息框的排版、图标和按钮样式差异很大，无法复用 macOS 参考样式。
  // 这里统一使用自绘 modal，保证 About 的品牌展示和多语言文案在三端一致。
  const iconPath = resolveAboutIconPath(app.isPackaged);
  const aboutWindow = new BrowserWindow({
    width: ABOUT_WINDOW_WIDTH,
    height:
      (isTinycode ? TINYCODE_NOTICE_CONTENT_HEIGHT : ABOUT_CONTENT_HEIGHT) +
      ABOUT_WINDOW_EXTRA_HEIGHT,
    parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
    modal: Boolean(parentWindow && !parentWindow.isDestroyed()),
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: aboutMessages.aboutTitle,
    icon: existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  aboutWindow.setMenuBarVisibility(false);
  aboutWindow.once("ready-to-show", () => {
    aboutWindow.show();
  });
  void aboutWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      createCustomAboutDialogHtml({
        applicationName: ABOUT_APPLICATION_NAME,
        appVersion: snapshot.appVersion,
        copyright: formatAboutCopyright(undefined, locale),
        optimizationLine: formatAboutOptimizationLine(snapshot, locale),
        versionLabel: aboutMessages.versionLabel,
        okButtonLabel: aboutMessages.okButtonLabel,
        sourceNotice: isTinycode ? aboutMessages.sourceNotice : "",
        onlineServiceNotice: isTinycode ? aboutMessages.onlineServiceNotice : "",
        logoHtml: isTinycode ? TINYCODE_LOGO_SVG : null,
        contentHeight: isTinycode ? TINYCODE_NOTICE_CONTENT_HEIGHT : ABOUT_CONTENT_HEIGHT,
      }),
    )}`,
  );
  return { response: 0, checkboxChecked: false };
}
