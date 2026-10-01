import type { ZCodeRuntimeEnv } from "./runtimeEnv.js";

export type ZCodeEnv = "test" | "production";
/**
 * 安装包身份：决定应用名、app id、Electron 数据目录与更新策略；与后端环境 `ZCodeEnv` 是两个轴。
 * `tinycode` 是对外发布的独立产品形态（基于 ZCode 修改，1WorldCapture 维护）：独立 appId/
 * 应用名/图标与独立数据根，更新与强更入口在 `!== "production"` 判断下自动关闭。
 */
export type ZCodeProductFlavor = "production" | "preview" | "tinycode";

/**
 * 各形态的用户可见应用名（运行时产品身份的显示名来源）。
 * 与构建脚本 desktop-product-identity.mjs 身份表的 productName 保持一致——
 * 构建期配置读 mjs 表，运行时（主进程/渲染层）读这里，两处由 identity 测试对账。
 */
export const ZCODE_PRODUCT_DISPLAY_NAMES: Record<ZCodeProductFlavor, string> = Object.freeze({
  production: "ZCode",
  preview: "ZCode Preview",
  tinycode: "TinyCode",
});
export type ArmsRumEnv = "local" | "prod";

// 非构建环境（如 e2e 测试的 mocha）下 define 不存在，用 typeof 检查 + fallback 避免 ReferenceError
declare const __ZCODE_ENV__: string;
declare const __ZCODE_PRODUCT_FLAVOR__: string;
declare const __ZCODE_RAFT_BUILD__: string;
declare const __ZCODE_DATA_ROOT_NAME__: string;

export function normalizeZCodeEnv(value: string | undefined): ZCodeEnv {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export const ZCODE_ENV = normalizeZCodeEnv(
  typeof __ZCODE_ENV__ !== "undefined" ? __ZCODE_ENV__ : undefined,
);

/**
 * 身份缺省跟随后端环境（test → preview，production → production）。
 * 桌面构建通过 `ZCODE_PREVIEW_IDENTITY=1` 显式注入 preview，得到连接生产后端的 Preview 包；
 * 未注入 define 的 bundle（web、CLI、测试）沿用旧的单轴语义。
 */
export function normalizeZCodeProductFlavor(
  value: string | undefined,
  zcodeEnv: ZCodeEnv,
): ZCodeProductFlavor {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "production" || normalized === "preview" || normalized === "tinycode") {
    return normalized;
  }
  return zcodeEnv === "production" ? "production" : "preview";
}

export const ZCODE_PRODUCT_FLAVOR = normalizeZCodeProductFlavor(
  typeof __ZCODE_PRODUCT_FLAVOR__ !== "undefined" ? __ZCODE_PRODUCT_FLAVOR__ : undefined,
  ZCODE_ENV,
);

/**
 * Raft 集成构建标志（构建期 define，`ZCODE_RAFT_BUILD=1` 时烧录 "1"）：
 * 为真时桌面主进程跳过官方 autoUpdater 与远端强制升级 gate——官方通道按 semver
 * 比较，预发布号（如 3.14.3-raft.1 < 3.14.3）会被误拦或被官方包覆盖（D 系列复核
 * 发现）。与 flavor 正交：Raft 构建保持 production 身份（沿用应用名与数据目录，
 * 覆盖安装升级），只关更新通道。非 Raft 构建（官方 CI、web、CLI、测试）恒 false。
 */
export const ZCODE_RAFT_BUILD: boolean =
  typeof __ZCODE_RAFT_BUILD__ !== "undefined" && __ZCODE_RAFT_BUILD__ === "1";

/**
 * 用户级数据根目录名（编译期 define）：production/preview 烧录 ".zcode"，TinyCode 烧录
 * ".tinycode"。这是**唯一**的数据根名来源——services/paths.ts、CLI 适配器的用户级路径、
 * 桌面侧引导/日志/MCP 目录都必须读它，不得再写字面 ".zcode"/".tinycode"。未注入 define
 * 的产物（独立 CLI、web、测试）回落 ".zcode"，与官方行为一致。
 * 注意：工作区级 `<workspace>/.zcode/`（项目配置/agent-memory/工作流档）不属用户数据根，不读此常量。
 */
export const ZCODE_DATA_ROOT_NAME: string =
  typeof __ZCODE_DATA_ROOT_NAME__ !== "undefined" ? __ZCODE_DATA_ROOT_NAME__ : ".zcode";
export const ZCODE_APP_VERSION_ENV = "ZCODE_APP_VERSION" as const;
export const ZCODE_BUILD_COMMIT_ID_ENV = "ZCODE_BUILD_COMMIT_ID" as const;

// ── 运行时环境变量（不经过编译打包，启动时从 process.env 读取） ──
// 启用调试模式，值为 inspect-brk 的端口号，如 ZCODE_DEBUG=9230
export const RUNTIME_ZCODE_DEBUG =
  typeof process !== "undefined" ? process.env.ZCODE_DEBUG : undefined;

// 恢复原因：写死 false 会让运行时已配置的数仓/ARMS 永远空转。
// 功能保持可用；实际出网由各出口的运行时端点检查决定，未配置不上报。
export const ZCODE_TELEMETRY_ENABLED: boolean = true;

/** 数仓事件上报端点：由运行时环境变量提供，未配置即停用，构建产物不内嵌。 */
export const ZCODE_TELEMETRY_REPORT_ENDPOINT =
  typeof process !== "undefined" ? (process.env.ZCODE_TELEMETRY_REPORT_ENDPOINT ?? "") : "";

/** ARMS RUM 接入端点：由运行时环境变量提供，未配置即停用，构建产物不内嵌。 */
export const ZCODE_ARMS_RUM_ENDPOINT =
  typeof process !== "undefined" ? (process.env.ZCODE_ARMS_RUM_ENDPOINT ?? "") : "";

/** 将本地运行态与编译期 ZCODE_ENV 映射为 ARMS 控制台识别的上报环境标签 */
export function mapZCodeEnvToArmsRumEnv(runtimeEnv: ZCodeRuntimeEnv): ArmsRumEnv {
  return runtimeEnv !== "development" && ZCODE_ENV === "production" ? "prod" : "local";
}
