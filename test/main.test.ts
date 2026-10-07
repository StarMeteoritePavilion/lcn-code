import { ok, rejects, strictEqual } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { main } from "../src/main.ts";
import type { Api, FetchFunction } from "../src/llm-api/index.ts";

interface RequestTool {
  type?: string;
  name?: string;
  strict?: boolean;
  function?: { name: string; strict?: boolean };
  custom?: { name: string };
}

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * 创建带独立配置及 JPEG 文件的演示目录，并在检查后清理。
 * @param api - 待检查的协议。
 * @param run - 在临时目录中执行的检查。
 * @param hasImageInput - 是否在模型配置中声明图片输入。
 * @param hasReasoning - 是否在模型配置中声明推理支持。
 * @param compat - 模型明确声明的协议兼容配置。
 * @returns 检查及目录清理完成。
 */
async function withDemo(
  api: Api,
  run: (directory: string) => Promise<void>,
  hasImageInput: boolean = true,
  hasReasoning: boolean = false,
  compat?: Record<string, unknown>,
): Promise<void> {
  const prefix = join(tmpdir(), "lcn-main-");
  const directory = await mkdtemp(prefix);
  const config = {
    provider: "演示提供商",
    model: "演示模型",
    modelProviders: [
      {
        name: "演示提供商",
        api,
        baseUrl: "https://example.test/v1",
        apiKey: "test-secret",
        models: [
          {
            id: "演示模型",
            input: hasImageInput ? ["text", "image"] : ["text"],
            reasoning: hasReasoning,
            compat,
          },
        ],
      },
    ],
  };
  try {
    await writeFile(join(directory, "settings.json"), JSON.stringify(config));
    const imageDirectory = join(directory, "docs");
    await mkdir(imageDirectory);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);
    await writeFile(join(imageDirectory, "logo.jpg"), jpeg);
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * 将精确协议事件编码成离线 SSE 响应。
 * @param events - 适配器需要消费的事件。
 * @returns 可交给 SDK 解析的流响应。
 */
function eventResponse(events: Record<string, unknown>[]): Response {
  const blocks = events.map((event: Record<string, unknown>): string => {
    const name = typeof event.type === "string" ? `event: ${event.type}\n` : "";
    return `${name}data: ${JSON.stringify(event)}\n\n`;
  });
  return new Response(blocks.join(""), { headers: { "Content-Type": "text/event-stream" } });
}

/**
 * 为三种适配器提供文本或工具调用的最小完整事件序列。
 * @param api - 精确协议标识。
 * @param name - 要返回的工具名；未提供时返回文本。
 * @param isCustom - 是否使用 OpenAI 自定义语法工具事件。
 * @returns 对应协议的离线响应。
 */
function modelResponse(api: Api, name?: string, isCustom: boolean = false): Response {
  const args =
    name === "add_numbers" ? { a: 2, b: 3 } : name === "echo_text" ? { input: "hello" } : {};
  const text = "离线演示回答";
  if (api === "openai-completions") {
    const delta = name
      ? {
          tool_calls: [
            {
              index: 0,
              id: "call_demo",
              type: isCustom ? "custom" : "function",
              ...(isCustom
                ? { custom: { name, input: "hello" } }
                : { function: { name, arguments: JSON.stringify(args) } }),
            },
          ],
        }
      : { content: text };
    return eventResponse([
      {
        id: "chat_demo",
        model: "演示模型",
        choices: [{ index: 0, delta, finish_reason: name ? "tool_calls" : "stop" }],
      },
    ]);
  }
  if (api === "openai-responses") {
    const item = name
      ? {
          type: isCustom ? "custom_tool_call" : "function_call",
          id: "fc_demo",
          call_id: "call_demo",
          name,
          ...(isCustom ? { input: "hello" } : { arguments: JSON.stringify(args) }),
          status: "completed",
        }
      : {
          type: "message",
          id: "msg_demo",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        };
    const events: Record<string, unknown>[] = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: isCustom ? { ...item, input: "" } : item,
      },
    ];
    if (isCustom) {
      events.push({
        type: "response.custom_tool_call_input.delta",
        output_index: 0,
        delta: "hello",
      });
      events.push({
        type: "response.custom_tool_call_input.done",
        output_index: 0,
        input: "hello",
      });
    }
    if (!name) {
      events.push({
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: text,
      });
    }
    events.push({ type: "response.output_item.done", output_index: 0, item });
    events.push({
      type: "response.completed",
      response: { id: "resp_demo", status: "completed", output: [item] },
    });
    return eventResponse(events);
  }
  const block = name
    ? { type: "tool_use", id: "call_demo", name, input: args }
    : { type: "text", text };
  return eventResponse([
    {
      type: "message_start",
      message: { id: "msg_demo", model: "演示模型", usage: { input_tokens: 1, output_tokens: 1 } },
    },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: name ? "tool_use" : "end_turn" },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

/**
 * 提取三种协议顶层或会话新增条目中的工具声明。
 * @param body - SDK 实际发送的请求数据。
 * @returns 当前请求携带的全部工具定义。
 */
function requestTools(body: Record<string, unknown>): RequestTool[] {
  const tools = [...((body.tools ?? []) as RequestTool[])];
  const messages = (body.messages ?? []) as Record<string, unknown>[];
  for (const message of messages) {
    tools.push(...((message.tools ?? []) as RequestTool[]));
    if (Array.isArray(message.content)) {
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type === "tool_addition") {
          const tool = block.tool as { definition: RequestTool };
          tools.push(tool.definition);
        }
      }
    }
  }
  for (const input of (body.input ?? []) as Record<string, unknown>[]) {
    if (input.type === "additional_tools" || input.type === "tool_search_output") {
      tools.push(...((input.tools ?? []) as RequestTool[]));
    }
  }
  return tools;
}

/**
 * 解析请求工具与结果，返回一次工具调用并让闭环后续请求完成。
 * @param api - 当前检查的协议。
 * @param captured - 保存实际请求以便断言协议与图片转换。
 * @returns 不访问网络的传输函数。
 */
function mockFetch(api: Api, captured: CapturedRequest[]): FetchFunction {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const body = (await request.json()) as Record<string, unknown>;
    captured.push({ url: request.url, body });
    const serialized = JSON.stringify(body);
    const hasResult =
      serialized.includes('"role":"tool"') ||
      serialized.includes('"type":"tool_result"') ||
      serialized.includes('"type":"function_call_output"') ||
      serialized.includes('"type":"custom_tool_call_output"');
    const tools = requestTools(body);
    const choice = body.tool_choice;
    const isDisabled =
      choice === "none" ||
      (typeof choice === "object" && choice !== null && "type" in choice && choice.type === "none");
    const forced =
      typeof choice === "object" && choice !== null ? (choice as RequestTool) : undefined;
    const forcedName = forced?.name ?? forced?.function?.name ?? forced?.custom?.name;
    const first =
      tools.find((tool: RequestTool): boolean => {
        const name = tool.name ?? tool.function?.name ?? tool.custom?.name;
        return name === (forcedName ?? "add_numbers");
      }) ?? tools[0];
    const name =
      !hasResult && !isDisabled
        ? (first?.name ?? first?.function?.name ?? first?.custom?.name)
        : undefined;
    return modelResponse(api, name, first?.type === "custom");
  };
}

function silence(context: TestContext): void {
  context.mock.method(console, "log", (): void => {});
  context.mock.method(console, "error", (): void => {});
}

describe("main", (): void => {
  for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
    it(`${api} 读取配置并完成四种入口、图片和工具闭环`, async (context: TestContext): Promise<void> => {
      silence(context);
      await withDemo(api, async (directory: string): Promise<void> => {
        const requests: CapturedRequest[] = [];
        const summary = await main(directory, mockFetch(api, requests));
        strictEqual(summary.failed, 0);
        ok(summary.passed > 0);
        const endpoint =
          api === "openai-completions"
            ? "/chat/completions"
            : api === "openai-responses"
              ? "/responses"
              : "/messages";
        ok(requests.length > 40);
        ok(
          requests.every((request: CapturedRequest): boolean => {
            const url = new URL(request.url);
            return url.pathname.endsWith(endpoint);
          }),
        );
        const serialized = JSON.stringify(requests);
        ok(serialized.includes("image/jpeg"));
        ok(serialized.includes("add_numbers"));
        ok(
          serialized.includes(
            api === "openai-completions"
              ? '"role":"tool"'
              : api === "openai-responses"
                ? "function_call_output"
                : "tool_result",
          ),
        );
      });
    });
  }

  it("已声明推理能力时三协议分别构建原生推理参数", async (context: TestContext): Promise<void> => {
    silence(context);
    for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
      await withDemo(
        api,
        async (directory: string): Promise<void> => {
          const requests: CapturedRequest[] = [];
          const summary = await main(directory, mockFetch(api, requests));
          strictEqual(summary.failed, 0);
          ok(summary.passed > 0);
          const field =
            api === "openai-completions"
              ? "reasoning_effort"
              : api === "openai-responses"
                ? "reasoning"
                : "thinking";
          ok(
            requests.some((request: CapturedRequest): boolean =>
              Object.hasOwn(request.body, field),
            ),
          );
        },
        true,
        true,
      );
    }
  });

  it("Anthropic 预算思考与自适应思考按配置发送对应参数", async (context: TestContext): Promise<void> => {
    silence(context);
    for (const adaptive of [false, true]) {
      await withDemo(
        "anthropic-messages",
        async (directory: string): Promise<void> => {
          const requests: CapturedRequest[] = [];
          const summary = await main(directory, mockFetch("anthropic-messages", requests));
          strictEqual(summary.failed, 0);
          const thinking = requests.filter((request: CapturedRequest): boolean => {
            const value = request.body.thinking as { type?: string } | undefined;
            return value?.type === (adaptive ? "adaptive" : "enabled");
          });
          ok(thinking.length >= 8);
          for (const request of thinking) {
            if (adaptive) {
              const config = request.body.output_config as { effort: string };
              ok(config.effort.length > 0);
            } else {
              const value = request.body.thinking as { budget_tokens: number };
              ok(value.budget_tokens > 0);
              ok(Number(request.body.max_tokens) > value.budget_tokens);
            }
          }
        },
        true,
        true,
        { forceAdaptiveThinking: adaptive },
      );
    }
  });

  it("明确声明的严格工具与会话新增工具在三协议完成闭环", async (context: TestContext): Promise<void> => {
    silence(context);
    const capabilities: Record<Api, Record<string, unknown>> = {
      "openai-completions": {
        supportsStrictMode: true,
        supportsMidConvoToolAdditions: true,
        supportsMidConvoSystemMessages: true,
      },
      "openai-responses": {
        supportsStrictMode: true,
        supportsAdditionalTools: true,
        supportsMidConvoSystemMessages: true,
      },
      "anthropic-messages": {
        supportsStrictTools: true,
        supportsMidConvoToolChanges: true,
        supportsMidConvoSystemMessages: true,
      },
    };
    for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
      await withDemo(
        api,
        async (directory: string): Promise<void> => {
          const requests: CapturedRequest[] = [];
          const summary = await main(directory, mockFetch(api, requests));
          strictEqual(summary.failed, 0);
          const hasStrict = requests.some((request: CapturedRequest): boolean => {
            const tools = requestTools(request.body);
            return tools.some(
              (tool: RequestTool): boolean =>
                tool.strict === true || tool.function?.strict === true,
            );
          });
          ok(hasStrict);
          const hasAdditions = requests.some((request: CapturedRequest): boolean => {
            if (api === "openai-completions") {
              const messages = request.body.messages as { role: string; tools?: RequestTool[] }[];
              return messages.some(
                (message: { role: string; tools?: RequestTool[] }): boolean =>
                  message.role === "system" && (message.tools?.length ?? 0) > 0,
              );
            }
            const serialized = JSON.stringify(request.body);
            return serialized.includes(
              api === "openai-responses" ? "additional_tools" : "tool_addition",
            );
          });
          ok(hasAdditions, api);
        },
        true,
        false,
        capabilities[api],
      );
    }
  });

  it("OpenAI 两种协议使用自定义语法工具并传回 hello", async (context: TestContext): Promise<void> => {
    silence(context);
    for (const api of ["openai-completions", "openai-responses"] as const) {
      await withDemo(
        api,
        async (directory: string): Promise<void> => {
          const requests: CapturedRequest[] = [];
          const summary = await main(directory, mockFetch(api, requests));
          strictEqual(summary.failed, 0);
          const custom = requests.filter((request: CapturedRequest): boolean => {
            const tools = requestTools(request.body);
            return tools.some((tool: RequestTool): boolean => tool.type === "custom");
          });
          ok(custom.length >= 8);
          const forced = custom.filter((request: CapturedRequest): boolean => {
            const choice = request.body.tool_choice as
              { type?: string; name?: string; custom?: { name: string } } | undefined;
            return (
              choice?.type === "custom" &&
              (choice.name === "echo_text" || choice.custom?.name === "echo_text")
            );
          });
          strictEqual(forced.length, 2);
          ok(
            custom.some((request: CapturedRequest): boolean => request.body.tool_choice === "auto"),
          );
          const results = custom.filter((request: CapturedRequest): boolean => {
            const serialized = JSON.stringify(request.body);
            return (
              serialized.includes(
                api === "openai-responses" ? "custom_tool_call_output" : '\"role\":\"tool\"',
              ) && serialized.includes("hello")
            );
          });
          strictEqual(results.length, 4);
        },
        true,
        false,
        { supportsOpenAIGrammarTools: true },
      );
    }
  });

  it("SIGINT 中断进行中的请求并拒绝整个演示", async (context: TestContext): Promise<void> => {
    silence(context);
    await withDemo("openai-completions", async (directory: string): Promise<void> => {
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

  it("未声明图片和推理时跳过对应场景", async (context: TestContext): Promise<void> => {
    silence(context);
    await withDemo(
      "openai-completions",
      async (directory: string): Promise<void> => {
        const requests: CapturedRequest[] = [];
        const summary = await main(directory, mockFetch("openai-completions", requests));
        strictEqual(summary.failed, 0);
        ok(summary.passed > 0);
        ok(summary.skipped > 0);
        const serialized = JSON.stringify(requests);
        strictEqual(serialized.includes("image/jpeg"), false);
      },
      false,
    );
  });

  it("配置错误和无效图片在发起请求前抛出异常", async (context: TestContext): Promise<void> => {
    silence(context);
    await withDemo("openai-completions", async (directory: string): Promise<void> => {
      let requests = 0;
      const fetch: FetchFunction = async (): Promise<Response> => {
        requests++;
        return modelResponse("openai-completions");
      };
      await writeFile(join(directory, "docs", "logo.jpg"), "不是 JPEG");
      await rejects(main(directory, fetch), /JPEG/);
      await writeFile(join(directory, "settings.json"), "{");
      await rejects(main(directory, fetch));
      strictEqual(requests, 0);
    });
  });

  it("请求失败记录失败场景并完成取消检查", async (context: TestContext): Promise<void> => {
    silence(context);
    await withDemo("openai-completions", async (directory: string): Promise<void> => {
      const fetch: FetchFunction = async (): Promise<Response> =>
        new Response('{"error":{"message":"离线请求失败"}}', {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      const summary = await main(directory, fetch);
      ok(summary.failed > 0);
      ok(summary.passed >= 4);
    });
  });
});
