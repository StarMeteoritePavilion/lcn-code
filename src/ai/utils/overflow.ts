import type { AssistantMessage } from "../types.ts";

/**
 * 用于检测各提供商上下文溢出的正则表达式，匹配输入超过模型窗口或请求大小上限的错误。Anthropic 同时报告 token 超限与 HTTP 413 的 request_too_large；OpenAI、LiteLLM、Google、xAI、Groq、OpenRouter、Poolside、Together AI、llama.cpp、LM Studio、GitHub Copilot、MiniMax、Kimi For Coding、DS4、Mistral 与 Ollama 使用各自的错误文本；DashScope/Qwen 使用 HTTP 400 的 invalid_parameter_error。z.ai 使用 code 为 1261 的错误，或通过 usage.input > contextWindow 静默报告溢出。Xiaomi MiMo 会截断输入以填满 contextWindow，返回 length 且 output 为 0，此情况通过停止原因、零输出及输入占满窗口共同检测。
 */
const OVERFLOW_PATTERNS = [
  /prompt (?:is )?too long/i, // Anthropic 与 z.ai 的 token 超限。
  /prompt exceeds max length/i, // z.ai 中国端点的 token 超限。
  /request_too_large/i, // Anthropic 请求字节数超限（HTTP 413）。
  /input is too long for requested model/i, // Amazon Bedrock 的上下文超限。
  /exceeds the context window/i, // OpenAI Completions 与 Responses 的上下文超限。
  // OpenAI 兼容代理（LiteLLM）的上下文超限。
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i, // Google Gemini 的上下文超限。
  /maximum prompt length is \d+/i, // xAI Grok 的上下文超限。
  /reduce the length of the messages/i, // Groq 的上下文超限。
  /maximum context length is \d+ tokens/i, // OpenRouter 多数后端的上下文超限。
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside 的上下文超限。
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI 的上下文超限。
  /exceeds the limit of \d+/i, // GitHub Copilot 的上下文超限。
  /exceeds the available context size/i, // llama.cpp 服务器的上下文超限。
  /greater than the context length/i, // LM Studio 的上下文超限。
  /context window exceeds limit/i, // MiniMax 的上下文超限。
  /exceeded model token limit/i, // Kimi For Coding 的上下文超限。
  /too large for model with \d+ maximum context length/i, // Mistral 的上下文超限。
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 服务器的上下文超限。
  /model_context_window_exceeded/i, // z.ai 通过非标准 finish_reason 返回的错误文本。
  /prompt too long; exceeded (?:max )?context length/i, // Ollama 显式报告的上下文超限。
  /range of input length should be/i, // DashScope / Qwen Token Plan 的输入长度超限。
  /context[_ ]length[_ ]exceeded/i, // 通用上下文超限匹配。
  /too many tokens/i, // 通用 token 数超限匹配。
  /token limit exceeded/i, // 通用 token 上限匹配。
];

/**
 * 表示非上下文溢出的错误模式，例如限流或服务端错误。即使错误同时匹配 OVERFLOW_PATTERNS，也排除溢出判断。例如 Bedrock 的 ThrottlingException: Too many tokens, please wait before trying again. 会命中 /too many tokens/i，但实际为限流。
 */
const NON_OVERFLOW_PATTERNS = [
  // AWS Bedrock 的非溢出错误，使用 formatBedrockError 的可读前缀。
  /^(Throttling error|Service unavailable):/i,
  /rate limit/i, // 通用限流错误。
  /too many requests/i, // 通用 HTTP 429 错误。
];

/**
 * 判断助手消息是否表示上下文溢出错误。
 *
 * @param message - 待检查的助手消息。
 * @param contextWindow - 可选的上下文窗口大小（token 数），用于检测静默溢出与长度截断溢出；未提供或为 0 时只检查错误信息。
 * @returns 消息表示上下文溢出时返回 `true`；否则返回 `false`。
 * @remarks
 * 处理三种情况：
 * 1. 错误型溢出：`stopReason` 为 `"error"` 且错误信息匹配 `OVERFLOW_PATTERNS`，同时不匹配限流、服务不可用等 `NON_OVERFLOW_PATTERNS`。
 * 2. 静默溢出（如 z.ai）：`stopReason` 为 `"stop"`，但 `usage.input + usage.cacheRead` 超过 `contextWindow`。
 * 3. 长度截断溢出（如 Xiaomi MiMo）：`stopReason` 为 `"length"`、`usage.output` 为 0，且 `usage.input + usage.cacheRead` 达到 `contextWindow` 的 99% 以上。
 *
 * 可靠检测（返回可识别错误信息）的提供方包括 Anthropic、OpenAI、Google Gemini、xAI、Groq、Mistral、OpenRouter、Together AI、llama.cpp、LM Studio、Kimi For Coding、DS4、DashScope/Qwen、z.ai 等，具体错误示例见 `OVERFLOW_PATTERNS` 上方注释。
 *
 * 不可靠检测：z.ai 有时静默接受溢出请求，需传入 `contextWindow`；Xiaomi MiMo 截断输入后以零输出返回 `"length"`，同样需传入 `contextWindow`；Ollama 部分部署会静默截断，由于无法得知预期 token 数，此类情况无法检测。
 *
 * 对于通过 settings.json 添加的自定义提供方，可能无法识别其溢出错误：可发送超出上下文窗口的请求，根据返回的 `errorMessage` 编写正则并加入 `OVERFLOW_PATTERNS`，或在调用本函数前自行检查错误信息。
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
  // 情况一：检查错误文本模式。
  if (message.stopReason === "error" && message.errorMessage) {
    // 排除已知的非溢出错误，例如节流或限流。
    const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p: RegExp): boolean =>
      p.test(message.errorMessage!),
    );
    if (
      !isNonOverflow &&
      OVERFLOW_PATTERNS.some((p: RegExp): boolean => p.test(message.errorMessage!))
    ) {
      return true;
    }
  }

  // 情况二：z.ai 式静默溢出，响应成功但输入用量超过上下文窗口。
  if (contextWindow && message.stopReason === "stop") {
    const inputTokens = message.usage.input + message.usage.cacheRead;
    if (inputTokens > contextWindow) {
      return true;
    }
  }

  // 情况三：Xiaomi MiMo 式 length 停止溢出。服务器截断超长输入以适配窗口，没有剩余空间生成输出；stopReason 为 length、output 为 0，且 input + cacheRead 填满窗口。
  if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
    const inputTokens = message.usage.input + message.usage.cacheRead;
    if (inputTokens >= contextWindow * 0.99) {
      return true;
    }
  }

  return false;
}

/**
 * 判断因长度停止的响应是否在未达到期望输出上限时就结束，即可尝试恢复的长度截断。
 *
 * @param message - 待检查的助手消息。
 * @param desiredMaxOutput - 调用方或模型原本期望的最大输出 token 数，必须是按上下文收紧之前的原始上限；不大于 0 时视为不可恢复。
 * @returns `stopReason` 为 `"length"`、`desiredMaxOutput` 大于 0 且实际输出 token 数小于该上限时返回 `true`；否则返回 `false`。
 * @remarks 此类响应可能由上下文压力或提供方截断导致，调用方可进行一次有限的压缩后重试。
 */
export function isRecoverableLength(message: AssistantMessage, desiredMaxOutput: number): boolean {
  return (
    message.stopReason === "length" &&
    desiredMaxOutput > 0 &&
    message.usage.output < desiredMaxOutput
  );
}

/**
 * 获取上下文溢出检测使用的正则列表，供测试使用。
 *
 * @returns `OVERFLOW_PATTERNS` 的浅拷贝数组，修改该数组不影响内部列表。
 */
export function getOverflowPatterns(): RegExp[] {
  return [...OVERFLOW_PATTERNS];
}
