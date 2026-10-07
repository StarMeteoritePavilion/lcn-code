import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { main } from "../src/main.ts";
import type { Api, FetchFunction } from "../src/llm-api/types.ts";
import type { ResolvedAiConfig } from "../src/config/index.ts";

/**
 * 创建独立的演示配置并在测试后删除临时目录。
 * @param run - 使用配置目录的测试函数。
 * @param hasImageInput - 是否声明模型图片输入能力。
 * @returns 测试及目录清理完成。
 */
async function withDemo(
  run: (directory: string) => Promise<void>,
  hasImageInput: boolean = false,
): Promise<void> {
  const prefix = join(tmpdir(), "lcn-agent-main-");
  const directory = await mkdtemp(prefix);
  const config = {
    provider: "演示提供商",
    model: "演示模型",
    modelProviders: [
      {
        name: "演示提供商",
        api: "openai-completions",
        baseUrl: "https://example.test/v1",
        apiKey: "test-secret",
        models: [
          { id: "演示模型", input: hasImageInput ? ["text", "image"] : ["text"], reasoning: false },
        ],
      },
    ],
  };
  try {
    await writeFile(join(directory, "settings.json"), JSON.stringify(config));
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function silence(context: TestContext): void {
  context.mock.method(console, "log", (): void => {});
  context.mock.method(console, "error", (): void => {});
}

describe("main：代理循环演示入口", (): void => {
  it("文本配置无需图片，使用代理工具并记录传输失败", async (context: TestContext): Promise<void> => {
    silence(context);
    await withDemo(async (directory: string): Promise<void> => {
      const bodies: Record<string, unknown>[] = [];
      const fetch: FetchFunction = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const request = new Request(input, init);
        bodies.push((await request.json()) as Record<string, unknown>);
        return new Response('{"error":{"message":"离线失败"}}', {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      };
      const summary = await main(directory, fetch);
      deepStrictEqual(summary, { passed: 0, failed: 13, skipped: 2 });
      strictEqual(bodies.length, 13);
      ok(
        bodies.some((body: Record<string, unknown>): boolean =>
          JSON.stringify(body.tools ?? []).includes("demo_echo"),
        ),
      );
    });
  });

  it("SIGINT 取消正在执行的代理请求，并移除监听器", async (context: TestContext): Promise<void> => {
    silence(context);
    await withDemo(async (directory: string): Promise<void> => {
      let requests = 0;
      const fetch: FetchFunction = async (
        _input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        requests++;
        process.emit("SIGINT");
        ok(init?.signal?.aborted);
        throw new DOMException("请求已中断", "AbortError");
      };
      const listeners = process.listenerCount("SIGINT");
      await rejects(main(directory, fetch), /中断/);
      strictEqual(requests, 1);
      strictEqual(process.listenerCount("SIGINT"), listeners);
    });
  });

  it("配置和图片无效时在模型请求前拒绝", async (context: TestContext): Promise<void> => {
    silence(context);
    await withDemo(async (directory: string): Promise<void> => {
      let requests = 0;
      const fetch: FetchFunction = async (): Promise<Response> => {
        requests++;
        throw new Error("不应发送请求");
      };
      await mkdir(join(directory, "docs"));
      await writeFile(join(directory, "docs", "logo.jpg"), "不是 JPEG");
      await rejects(main(directory, fetch), /JPEG/);
      await writeFile(join(directory, "settings.json"), "{");
      await rejects(main(directory, fetch));
      strictEqual(requests, 0);
    }, true);
  });
});

interface Call {
  id: string;
  name: string;
  arguments: { value: number | string };
}

/**
 * 用最小完整协议事件构造离线助手回复，真实网络演示不使用此函数。
 * @param api - 需要验证的精确协议。
 * @param calls - 本次回复中的工具调用；空数组表示文本回复。
 * @param reasoningTokens - Responses 回复声明的推理用量，不生成可见思考内容。
 * @returns 供 SDK 和协议解析器消费的 SSE 响应。
 */
function response(api: Api, calls: Call[], reasoningTokens: number = 0): Response {
  const events: Record<string, unknown>[] = [];
  if (api === "anthropic-messages") {
    events.push({
      type: "message_start",
      message: {
        id: "msg_demo",
        model: "offline-model",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const blocks =
      calls.length > 0
        ? calls.map((call: Call): Record<string, unknown> => ({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.arguments,
          }))
        : [{ type: "text", text: "" }];
    for (const [index, block] of blocks.entries()) {
      events.push({ type: "content_block_start", index, content_block: block });
      if (calls.length === 0) {
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: "离线回复。" },
        });
      } else {
        events.push({
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(calls[index]?.arguments),
          },
        });
      }
      events.push({ type: "content_block_stop", index });
    }
    events.push(
      {
        type: "message_delta",
        delta: { stop_reason: calls.length ? "tool_use" : "end_turn" },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    );
  } else if (api === "openai-completions") {
    const delta =
      calls.length > 0
        ? {
            tool_calls: calls.map((call: Call, index: number): Record<string, unknown> => ({
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }
        : { content: "离线回复。" };
    events.push({
      id: "chat_demo",
      model: "offline-model",
      choices: [{ index: 0, delta, finish_reason: calls.length ? "tool_calls" : "stop" }],
    });
  } else {
    const output =
      calls.length > 0
        ? calls.map((call: Call): Record<string, unknown> => ({
            type: "function_call",
            id: `fc_${call.id}`,
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
            status: "completed",
          }))
        : [
            {
              type: "message",
              id: "msg_demo",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "离线回复。", annotations: [] }],
            },
          ];
    for (const [index, item] of output.entries()) {
      events.push({ type: "response.output_item.added", output_index: index, item });
      if (calls.length === 0) {
        events.push({
          type: "response.output_text.delta",
          item_id: "msg_demo",
          output_index: index,
          content_index: 0,
          delta: "离线回复。",
        });
      } else {
        events.push({
          type: "response.function_call_arguments.delta",
          item_id: item.id,
          output_index: index,
          delta: item.arguments,
        });
      }
      events.push({ type: "response.output_item.done", output_index: index, item });
    }
    events.push({
      type: "response.completed",
      response: {
        id: "resp_demo",
        status: "completed",
        output,
        usage: {
          input_tokens: 1,
          output_tokens: reasoningTokens + 1,
          total_tokens: reasoningTokens + 2,
          output_tokens_details: { reasoning_tokens: reasoningTokens },
        },
      },
    });
  }
  const blocks = events.map((event: Record<string, unknown>): string => {
    const label = typeof event.type === "string" ? `event: ${event.type}\n` : "";
    return `${label}data: ${JSON.stringify(event)}\n\n`;
  });
  return new Response(blocks.join(""), { headers: { "Content-Type": "text/event-stream" } });
}

/**
 * 创建当前精确协议的测试配置，所有传输均被离线替换。
 * @param api - 被测协议。
 * @param captured - 保存真实构建的请求选项以便断言。
 * @param shouldFail - 是否以 HTTP 错误检查统计行为。
 * @param shouldReturnBatch - 是否遵守同一条响应的两次工具调用要求。
 * @param reasoningTokens - 离线 Responses 回复的推理用量。
 * @returns 可交给演示入口的独立配置。
 */
function config(
  api: Api,
  captured: Record<string, unknown>[],
  shouldFail: boolean = false,
  shouldReturnBatch: boolean = true,
  reasoningTokens: number = 0,
): ResolvedAiConfig {
  /**
   * 拦截请求并按精确协议字段构造工具或文本回复。
   * @param input - SDK 提供的请求地址。
   * @param init - SDK 提供的请求数据。
   * @returns 离线 SSE 或 HTTP 错误响应。
   */
  const fetch: FetchFunction = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const body = (await request.json()) as Record<string, unknown>;
    captured.push(body);
    if (shouldFail) {
      return new Response(JSON.stringify({ error: { type: "api_error", message: "离线错误" } }), {
        status: 500,
      });
    }
    const choice = body.tool_choice as
      { type?: string; name?: string; function?: { name: string } } | undefined;
    const name =
      choice?.type === "tool" || choice?.type === "function"
        ? api === "openai-completions"
          ? choice.function?.name
          : choice.name
        : undefined;
    const calls: Call[] = name ? [{ id: "call_first", name, arguments: { value: 10 } }] : [];
    const encoded = JSON.stringify(body);
    if (name && shouldReturnBatch && encoded.includes("在同一条助手响应中")) {
      calls.push({ id: "call_second", name, arguments: { value: 20 } });
    }
    return response(api, calls, reasoningTokens);
  };
  return {
    model: {
      id: "offline-model",
      name: "离线测试模型",
      api,
      baseUrl: "https://example.test/v1",
      reasoning: false,
      input: ["text"],
      maxTokens: 512,
      contextWindow: 128000,
      compat:
        api === "anthropic-messages"
          ? { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true }
          : undefined,
    },
    options: { apiKey: "offline-secret", fetch, maxRetries: 0, maxTokens: 512 },
  };
}

/**
 * 将离线模型配置写入临时目录，通过公开 main 入口运行代理场景。
 * @param config - 包含离线传输和明确模型声明的配置。
 * @param image - 可选的 JPEG 字节，仅在图片场景中写入临时目录。
 * @returns 公开入口的场景统计；临时目录在结束后删除。
 */
async function runConfiguredDemo(
  config: ResolvedAiConfig,
  image?: Uint8Array,
): Promise<Awaited<ReturnType<typeof main>>> {
  const prefix = join(tmpdir(), "lcn-agent-scenarios-");
  const directory = await mkdtemp(prefix);
  const { fetch, apiKey, ...requestOptions } = config.options;
  const settings = {
    provider: "离线提供商",
    model: config.model.id,
    modelProviders: [
      {
        name: "离线提供商",
        api: config.model.api,
        baseUrl: config.model.baseUrl,
        apiKey,
        requestOptions,
        models: [config.model],
      },
    ],
  };
  try {
    await writeFile(join(directory, "settings.json"), JSON.stringify(settings));
    if (image) {
      await mkdir(join(directory, "docs"));
      await writeFile(join(directory, "docs", "logo.jpg"), image);
    }
    return await main(directory, fetch);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("main：代理功能场景", (): void => {
  it("推理场景使用 high，允许有推理用量但没有可见思考块", async (context: TestContext): Promise<void> => {
    silence(context);
    const captured: Record<string, unknown>[] = [];
    const settings = config("openai-responses", captured, false, true, 17);
    settings.model.reasoning = true;
    const summary = await runConfiguredDemo(settings);
    deepStrictEqual(summary, { passed: 14, failed: 0, skipped: 1 });
    ok(
      captured.some((body: Record<string, unknown>): boolean => {
        const reasoning = body.reasoning as { effort?: string } | undefined;
        return reasoning?.effort === "high";
      }),
    );
  });

  it("声明支持推理但既无思考内容也无推理用量时仍失败", async (context: TestContext): Promise<void> => {
    silence(context);
    const settings = config("openai-responses", [], false, true, 0);
    settings.model.reasoning = true;
    const summary = await runConfiguredDemo(settings);
    deepStrictEqual(summary, { passed: 13, failed: 1, skipped: 1 });
  });
  for (const api of ["anthropic-messages", "openai-completions", "openai-responses"] as const) {
    it(`${api} 离线验证代理调度与断言`, async (context: TestContext): Promise<void> => {
      silence(context);
      const chunks: string[] = [];
      const write = process.stdout.write;
      context.mock.method(
        process.stdout,
        "write",
        (chunk: string | Uint8Array, ...args: unknown[]): boolean => {
          if (typeof chunk === "string") {
            chunks.push(chunk);
            return true;
          }
          return Reflect.apply(write, process.stdout, [chunk, ...args]);
        },
      );
      const captured: Record<string, unknown>[] = [];
      const summary = await runConfiguredDemo(config(api, captured));
      deepStrictEqual(summary, { passed: 13, failed: 0, skipped: 2 });
      ok(captured.length >= 20 && captured.length <= 35);
      strictEqual(chunks.join(""), "离线回复。离线回复。");
    });
  }
  it("模型没有返回同批多个调用时调度场景失败", async (context: TestContext): Promise<void> => {
    silence(context);
    const summary = await runConfiguredDemo(config("anthropic-messages", [], false, false));
    deepStrictEqual(summary, { passed: 8, failed: 5, skipped: 2 });
  });
  it("所有传输失败时不会把场景记为通过", async (context: TestContext): Promise<void> => {
    silence(context);
    const summary = await runConfiguredDemo(config("anthropic-messages", [], true));
    deepStrictEqual(summary, { passed: 0, failed: 13, skipped: 2 });
  });
});

describe("main：图片、推理与请求边界", (): void => {
  it("JPEG 图片能力发送实际图片内容并通过图片场景", async (context: TestContext): Promise<void> => {
    silence(context);
    const captured: Record<string, unknown>[] = [];
    const settings = config("openai-completions", captured);
    settings.model.input = ["text", "image"];
    const image = await readFile(new URL("../../../docs/logo.jpg", import.meta.url));
    const summary = await runConfiguredDemo(settings, image);
    deepStrictEqual(summary, { passed: 14, failed: 0, skipped: 1 });
    const imageRequests = captured.filter((body: Record<string, unknown>): boolean =>
      JSON.stringify(body.messages).includes("data:image/jpeg;base64,"),
    );
    strictEqual(imageRequests.length, 1);
    ok(JSON.stringify(imageRequests[0]).includes(image.toString("base64")));
  });

  for (const isAdaptive of [false, true]) {
    it(`Anthropic ${isAdaptive ? "自适应" : "预算"}思考设置进入请求，缺少推理证据仍判为失败`, async (context: TestContext): Promise<void> => {
      silence(context);
      const captured: Record<string, unknown>[] = [];
      const settings = config("anthropic-messages", captured);
      settings.model.reasoning = true;
      settings.model.maxTokens = 16384;
      settings.options.maxTokens = 4096;
      settings.model.compat = {
        supportsMidConvoSystemMessages: true,
        supportsMidConvoToolChanges: true,
        forceAdaptiveThinking: isAdaptive,
      };
      if (isAdaptive) {
        settings.model.thinkingLevelMap = { high: "medium" };
      }
      const summary = await runConfiguredDemo(settings);
      deepStrictEqual(summary, { passed: 13, failed: 1, skipped: 1 });
      const request = captured.at(-1);
      if (isAdaptive) {
        deepStrictEqual(request?.thinking, { type: "adaptive", display: "summarized" });
        deepStrictEqual(request?.output_config, { effort: "medium" });
      } else {
        const thinking = request?.thinking as { type: string; budget_tokens: number };
        strictEqual(thinking.type, "enabled");
        ok(thinking.budget_tokens > 0);
        ok(Number(request?.max_tokens) > thinking.budget_tokens);
      }
    });
  }

  it("持续工具调用达到每场景请求上限，错误统计不依赖额外模型请求", async (context: TestContext): Promise<void> => {
    const errors: string[] = [];
    silence(context);
    context.mock.method(console, "error", (message: string): void => {
      errors.push(message);
    });
    const settings = config("anthropic-messages", []);
    let requests = 0;
    /**
     * 持续返回工具调用，使场景达到内置请求上限。
     * @returns 离线工具调用响应。
     */
    settings.options.fetch = async (): Promise<Response> => {
      requests++;
      return response("anthropic-messages", [
        { id: "endless", name: "demo_echo", arguments: { value: 10 } },
      ]);
    };
    const summary = await runConfiguredDemo(settings);
    ok(summary.failed > 0);
    strictEqual(summary.passed + summary.failed + summary.skipped, 15);
    ok(errors.some((message: string): boolean => message.includes("场景超过 4 次请求上限")));
    ok(requests <= 13 * 4);
  });

  it("无法转换的工具参数跳过执行并记录场景失败", async (context: TestContext): Promise<void> => {
    silence(context);
    const settings = config("anthropic-messages", []);
    /**
     * 返回无法通过数字模式校验的参数。
     * @returns 含异常工具参数的离线响应。
     */
    settings.options.fetch = async (): Promise<Response> =>
      response("anthropic-messages", [
        { id: "invalid", name: "demo_echo", arguments: { value: "不可转数字" } },
      ]);
    const summary = await runConfiguredDemo(settings);
    ok(summary.failed > 0);
    strictEqual(summary.passed + summary.failed + summary.skipped, 15);
  });
});

describe("main：场景之间的取消与直接入口", (): void => {
  it("完成首个场景后收到 SIGINT，下一场景不发起请求且移除监听器", async (context: TestContext): Promise<void> => {
    silence(context);
    const captured: Record<string, unknown>[] = [];
    context.mock.method(console, "log", (message?: string): void => {
      if (message?.startsWith("agent-loop / 入口与继续：")) {
        process.emit("SIGINT");
      }
    });
    const listeners = process.listenerCount("SIGINT");
    await rejects(runConfiguredDemo(config("anthropic-messages", captured)), /代理循环演示已中断/);
    strictEqual(captured.length, 2);
    strictEqual(process.listenerCount("SIGINT"), listeners);
  });

  it("直接启动时配置缺失输出失败原因并以非零退出码收尾", async (): Promise<void> => {
    const prefix = join(tmpdir(), "lcn-agent-cli-");
    const directory = await mkdtemp(prefix);
    const entryPath = fileURLToPath(new URL("../src/main.js", import.meta.url));
    try {
      const result = spawnSync(process.execPath, [entryPath], {
        cwd: directory,
        encoding: "utf8",
        timeout: 5000,
      });
      strictEqual(result.error, undefined);
      strictEqual(result.signal, null);
      strictEqual(result.status, 1);
      ok(result.stderr.includes("运行失败："));
      ok(result.stderr.includes("provider"));
      strictEqual(result.stdout, "");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("main：直接入口的场景失败收尾", (): void => {
  it("离线模型请求全部失败时打印统计并设置非零退出码", async (): Promise<void> => {
    await withDemo(async (directory: string): Promise<void> => {
      const entryPath = fileURLToPath(new URL("../src/main.js", import.meta.url));
      const preloadPath = join(directory, "offline-fetch.mjs");
      await writeFile(
        preloadPath,
        'globalThis.fetch = async () => new Response("离线请求失败", { status: 500 });',
      );
      const result = spawnSync(process.execPath, ["--import", preloadPath, entryPath], {
        cwd: directory,
        encoding: "utf8",
        timeout: 5000,
      });
      strictEqual(result.error, undefined);
      strictEqual(result.signal, null);
      strictEqual(result.status, 1);
      ok(result.stdout.includes("成功 0，失败 13，跳过 2"));
      strictEqual(result.stderr.includes("运行失败："), false);
      ok(result.stderr.includes("离线请求失败"));
    });
  });
});

describe("main：自适应推理级别回退", (): void => {
  it("high 被禁用时选择 minimal，并将自适应 effort 映射为 low", async (context: TestContext): Promise<void> => {
    silence(context);
    const captured: Record<string, unknown>[] = [];
    const settings = config("anthropic-messages", captured);
    settings.model.reasoning = true;
    settings.model.thinkingLevelMap = { high: null };
    settings.model.compat = {
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolChanges: true,
      forceAdaptiveThinking: true,
    };
    const summary = await runConfiguredDemo(settings);
    deepStrictEqual(summary, { passed: 13, failed: 1, skipped: 1 });
    deepStrictEqual(captured.at(-1)?.output_config, { effort: "low" });
    deepStrictEqual(captured.at(-1)?.thinking, { type: "adaptive", display: "summarized" });
  });
});

describe("main：可见思考内容", (): void => {
  it("自适应思考没有自定义映射时沿用 high，可见思考块满足推理证据", async (context: TestContext): Promise<void> => {
    silence(context);
    const captured: Record<string, unknown>[] = [];
    const settings = config("anthropic-messages", captured);
    settings.model.reasoning = true;
    settings.model.compat = {
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolChanges: true,
      forceAdaptiveThinking: true,
    };
    const originalFetch = settings.options.fetch;
    ok(originalFetch);
    /**
     * 在推理请求的离线响应中追加可见思考内容块。
     * @param input - 当前请求地址。
     * @param init - 当前请求选项。
     * @returns 包含真实协议思考事件的离线回复。
     */
    settings.options.fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const original = await originalFetch(input, init);
      if (!captured.at(-1)?.thinking) {
        return original;
      }
      const text = await original.text();
      const thinkingEvents = [
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "thinking", thinking: "" },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "thinking_delta", thinking: "计算余数。" },
        },
        { type: "content_block_stop", index: 1 },
      ];
      const blocks = thinkingEvents.map(
        (event: Record<string, unknown>): string =>
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
      return new Response(
        text.replace("event: message_delta", `${blocks.join("")}event: message_delta`),
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    };
    const summary = await runConfiguredDemo(settings);
    deepStrictEqual(summary, { passed: 14, failed: 0, skipped: 1 });
    deepStrictEqual(captured.at(-1)?.output_config, { effort: "high" });
  });
});

describe("main：无入口路径的模块导入", (): void => {
  it("Node 模块求值导入时没有 argv[1]，不加载配置或发送模型请求", async (): Promise<void> => {
    const prefix = join(tmpdir(), "lcn-agent-module-");
    const directory = await mkdtemp(prefix);
    const entryUrl = new URL("../src/main.js", import.meta.url).href;
    const script = `
      import { strictEqual } from "node:assert";
      strictEqual(process.argv[1], undefined);
      let requests = 0;
      globalThis.fetch = async () => {
        requests++;
        throw new Error("导入不应请求模型");
      };
      await import(${JSON.stringify(entryUrl)});
      strictEqual(requests, 0);
    `;
    try {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: directory,
        encoding: "utf8",
        timeout: 5000,
      });
      strictEqual(result.error, undefined);
      strictEqual(result.signal, null);
      strictEqual(result.status, 0);
      strictEqual(result.stdout, "");
      strictEqual(result.stderr, "");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
