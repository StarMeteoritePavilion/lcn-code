import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new Error(`Failed to read configuration file: ${path}`);
  }
}

/**
 * 按 Pi 的模板语法替换字符串中的环境变量，保留字面量和转义。
 * @param value - 包含 $NAME、${NAME}、$$ 或 $! 的字符串。
 * @param env - 从 .env 读取的环境变量，非空值优先于进程环境。
 * @param path - 用于定位缺失变量的配置路径。
 * @returns 替换后的字符串，不递归解释替换结果。
 * @throws 引用的环境变量在两处均不存在或为空时抛出错误。
 */
function replaceString(value: string, env: NodeJS.Dict<string>, path: string): string {
  return value.replace(
    /\$(\$|!|\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/g,
    (match: string, reference: string): string => {
      if (reference === "$" || reference === "!") {
        return reference;
      }
      const name = reference.startsWith("{") ? reference.slice(1, -1) : reference;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return match;
      }
      const fileValue = Object.hasOwn(env, name) ? env[name] : undefined;
      const processValue = Object.hasOwn(process.env, name) ? process.env[name] : undefined;
      const resolved = fileValue || processValue;
      if (!resolved) {
        throw new Error(`Missing environment variable for configuration ${path}: ${name}`);
      }
      return resolved;
    },
  );
}

function replaceValues(value: unknown, env: NodeJS.Dict<string>, path: string): unknown {
  if (typeof value === "string") {
    return replaceString(value, env, path);
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown, index: number): unknown =>
      replaceValues(item, env, `${path}[${index}]`),
    );
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const entries = Object.entries(value).map(([key, item]: [string, unknown]): [string, unknown] => {
    return [key, replaceValues(item, env, `${path}.${key}`)];
  });
  return Object.fromEntries(entries);
}

/**
 * 读取指定目录的 settings.json 并替换配置值中的环境变量。
 * @param directory - 配置目录，默认使用调用时的工作目录；.env 从同一目录读取。
 * @returns 完成替换的 JSON 数据；settings.json 不存在时返回空对象，业务校验由使用方执行。
 * @throws 文件读取失败、JSON 无法解析或引用的环境变量缺失时抛出错误。
 * @remarks 支持 Pi 的行注释、尾逗号和 BOM；.env 的非空值优先于进程环境，不修改 process.env，不执行命令。
 */
export async function loadConfig(directory: string = process.cwd()): Promise<unknown> {
  const configPath = join(directory, "settings.json");
  const content = await readOptionalFile(configPath);
  if (content === undefined) {
    return {};
  }
  const withoutBom = content.replace(/^\uFEFF/, "");
  const withoutComments = withoutBom.replace(
    /"(?:\\.|[^"\\])*"|\/\/[^\n]*/g,
    (match: string): string => (match.startsWith('"') ? match : ""),
  );
  const json = withoutComments.replace(
    /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
    (match: string, tail: string | undefined): string => tail ?? match,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`Invalid configuration JSON: ${configPath}`);
  }
  const envPath = join(directory, ".env");
  const envContent = await readOptionalFile(envPath);
  const env = envContent === undefined ? {} : parseEnv(envContent);
  return replaceValues(parsed, env, "setting");
}
