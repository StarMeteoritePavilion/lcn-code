import type * as NodeOs from "node:os";

type ProcessWithOsBuiltinModule = typeof process & {
  getBuiltinModule?: (id: "node:os") => typeof NodeOs;
};

interface NodeOsCache {
  isLoaded: boolean;
  value: typeof NodeOs | null;
}

// 保持操作系统模块加载与浏览器兼容；顶层运行时导入 node:os 会破坏浏览器或 Vite 构建。首次使用时才加载，导入本文件不会触发该副作用。
const NODE_OS_CACHE: NodeOsCache = { isLoaded: false, value: null };

/**
 * 在 Node.js 或 Bun 运行时中通过 `process.getBuiltinModule` 加载 `node:os` 模块。
 * @returns `node:os` 模块；在浏览器等非 Node.js/Bun 环境或运行时不支持 `getBuiltinModule` 时返回 null。
 */
function loadNodeOs(): typeof NodeOs | null {
  if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
    return null;
  }
  return (process as ProcessWithOsBuiltinModule).getBuiltinModule?.("node:os") ?? null;
}

/**
 * 获取 `node:os` 模块，首次调用时加载并缓存结果。
 * @returns `node:os` 模块；不可用时返回 null。
 */
function getNodeOs(): typeof NodeOs | null {
  if (!NODE_OS_CACHE.isLoaded) {
    NODE_OS_CACHE.value = loadNodeOs();
    NODE_OS_CACHE.isLoaded = true;
  }
  return NODE_OS_CACHE.value;
}

/**
 * 生成发送给模型提供方的 `User-Agent` 请求头值。
 * @returns 可访问 `node:os` 时为 `pi (<platform> <release>; <arch>)`，否则为 `pi (browser)`。
 * @remarks 首次调用时惰性加载 `node:os` 并缓存，之后的调用复用缓存结果。
 */
export function getPiUserAgent(): string {
  const nodeOs = getNodeOs();
  return nodeOs
    ? `pi (${nodeOs.platform()} ${nodeOs.release()}; ${nodeOs.arch()})`
    : "pi (browser)";
}
