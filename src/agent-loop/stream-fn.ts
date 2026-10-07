import type { StreamFn } from "./types.ts";

let defaultStreamFn: StreamFn | undefined;

/**
 * 设置或清除代理循环使用的默认流式请求函数。
 *
 * @param streamFn - 默认流式请求函数；传入 `undefined` 时清除已有配置。
 * @remarks 修改当前模块保存的默认函数，后续获取默认函数时使用新配置。
 */
export function setDefaultStreamFn(streamFn: StreamFn | undefined): void {
  defaultStreamFn = streamFn;
}

/**
 * 获取已配置的默认流式请求函数。
 *
 * @returns 当前模块保存的默认流式请求函数。
 * @throws 默认流式请求函数未配置或已被清除时抛出错误。
 */
export function getDefaultStreamFn(): StreamFn {
  if (!defaultStreamFn) {
    throw new Error(
      "No default stream function configured. Pass streamFn explicitly or call setDefaultStreamFn().",
    );
  }
  return defaultStreamFn;
}
