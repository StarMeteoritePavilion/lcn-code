import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config/index.ts";

/**
 * 在独立临时目录中运行配置读取检查，并在结束后清理文件。
 * @param run - 使用临时配置目录的检查函数。
 * @returns 检查完成且临时目录清理完毕。
 */
async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const prefix = join(tmpdir(), "lcn-config-");
  const directory = await mkdtemp(prefix);
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("loadConfig", (): void => {
  it("支持 Pi 的 BOM、行注释及尾逗号，并保留 URL 和字符串内容", async (): Promise<void> => {
    await withDirectory(async (directory: string): Promise<void> => {
      const path = join(directory, "settings.json");
      await writeFile(
        path,
        '\uFEFF{\n// 配置说明\n"url":"https://example.test/v1", "text":",}", "list":[1,],\n}',
      );
      deepStrictEqual(await loadConfig(directory), {
        url: "https://example.test/v1",
        text: ",}",
        list: [1],
      });
    });
  });

  it("递归替换值，保持键名不变，并优先使用 .env", async (): Promise<void> => {
    await withDirectory(async (directory: string): Promise<void> => {
      await writeFile(
        join(directory, "settings.json"),
        JSON.stringify({
          "${LCN_CONFIG_TEST_KEY}": [
            "${LCN_CONFIG_TEST_KEY}",
            "$LCN_CONFIG_TEST_KEY",
            "$$LCN_CONFIG_TEST_KEY",
            "$!literal",
            null,
            1,
          ],
        }),
      );
      await writeFile(join(directory, ".env"), 'LCN_CONFIG_TEST_KEY="来自文件"');
      const previous = process.env.LCN_CONFIG_TEST_KEY;
      process.env.LCN_CONFIG_TEST_KEY = "来自进程";
      try {
        deepStrictEqual(await loadConfig(directory), {
          "${LCN_CONFIG_TEST_KEY}": [
            "来自文件",
            "来自文件",
            "$LCN_CONFIG_TEST_KEY",
            "!literal",
            null,
            1,
          ],
        });
        strictEqual(process.env.LCN_CONFIG_TEST_KEY, "来自进程");
      } finally {
        if (previous === undefined) {
          delete process.env.LCN_CONFIG_TEST_KEY;
        } else {
          process.env.LCN_CONFIG_TEST_KEY = previous;
        }
      }
    });
  });

  it(".env 中的空值按 Pi 规则回退到进程环境", async (): Promise<void> => {
    await withDirectory(async (directory: string): Promise<void> => {
      await writeFile(join(directory, "settings.json"), '"$LCN_CONFIG_TEST_FALLBACK"');
      await writeFile(join(directory, ".env"), "LCN_CONFIG_TEST_FALLBACK=");
      const previous = process.env.LCN_CONFIG_TEST_FALLBACK;
      process.env.LCN_CONFIG_TEST_FALLBACK = "进程值";
      try {
        strictEqual(await loadConfig(directory), "进程值");
      } finally {
        if (previous === undefined) {
          delete process.env.LCN_CONFIG_TEST_FALLBACK;
        } else {
          process.env.LCN_CONFIG_TEST_FALLBACK = previous;
        }
      }
    });
  });

  it("配置文件缺失时返回空对象", async (): Promise<void> => {
    await withDirectory(async (directory: string): Promise<void> => {
      deepStrictEqual(await loadConfig(directory), {});
    });
  });

  it("无 .env 时保留静态配置与无效变量语法", async (): Promise<void> => {
    await withDirectory(async (directory: string): Promise<void> => {
      await writeFile(
        join(directory, "settings.json"),
        '["${not-valid}", "${not-valid$LCN_CONFIG_TEST_INVALID}", "${", "$", "!literal", false]',
      );
      deepStrictEqual(await loadConfig(directory), [
        "${not-valid}",
        "${not-valid$LCN_CONFIG_TEST_INVALID}",
        "${",
        "$",
        "!literal",
        false,
      ]);
    });
  });

  it("JSON 错误时仅报告文件位置，不泄露配置内容", async (): Promise<void> => {
    await withDirectory(async (directory: string): Promise<void> => {
      await writeFile(join(directory, "settings.json"), '{"apiKey":"不能出现在错误中", bad}');
      await rejects(loadConfig(directory), (error: unknown): boolean => {
        return (
          error instanceof Error &&
          error.message.includes("Invalid configuration JSON:") &&
          !error.message.includes("不能出现在错误中")
        );
      });
    });
  });

  it("变量缺失时报告精确路径与变量名称", async (): Promise<void> => {
    await withDirectory(async (directory: string): Promise<void> => {
      await writeFile(
        join(directory, "settings.json"),
        '{"models":[{"key":"${LCN_CONFIG_TEST_MISSING}"}]}',
      );
      const previous = process.env.LCN_CONFIG_TEST_MISSING;
      delete process.env.LCN_CONFIG_TEST_MISSING;
      try {
        await rejects(
          loadConfig(directory),
          /Missing environment variable for configuration setting\.models\[0\]\.key: LCN_CONFIG_TEST_MISSING/,
        );
      } finally {
        if (previous !== undefined) {
          process.env.LCN_CONFIG_TEST_MISSING = previous;
        }
      }
    });
  });

  it("不将对象原型属性当作环境变量", async (): Promise<void> => {
    await withDirectory(async (directory: string): Promise<void> => {
      await writeFile(join(directory, "settings.json"), '"${toString}"');
      const previous = process.env.toString;
      Reflect.deleteProperty(process.env, "toString");
      try {
        await rejects(
          loadConfig(directory),
          /Missing environment variable for configuration setting: toString/,
        );
      } finally {
        if (Object.hasOwn(process.env, "toString")) {
          Reflect.deleteProperty(process.env, "toString");
        }
        if (typeof previous === "string") {
          process.env.toString = previous;
        }
      }
    });
  });
});

describe("loadConfig 文件读取失败", (): void => {
  it("settings.json 是目录时报告读取失败", async (): Promise<void> => {
    await withDirectory(async (directory: string): Promise<void> => {
      await mkdir(join(directory, "settings.json"));
      await rejects(loadConfig(directory), /Failed to read configuration file:.*settings\.json/);
    });
  });
  it(".env 是目录时报告读取失败", async (): Promise<void> => {
    await withDirectory(async (directory: string): Promise<void> => {
      await writeFile(join(directory, "settings.json"), "{}");
      await mkdir(join(directory, ".env"));
      await rejects(loadConfig(directory), /Failed to read configuration file:.*\.env/);
    });
  });
});
