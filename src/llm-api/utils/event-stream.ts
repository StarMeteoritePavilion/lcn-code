import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

class FifoQueue<T> {
  private incoming: T[] = [];
  private outgoing: T[] = [];

  get length(): number {
    return this.incoming.length + this.outgoing.length;
  }

  enqueue(value: T): void {
    this.incoming.push(value);
  }

  dequeue(): T | undefined {
    if (this.outgoing.length === 0) {
      while (this.incoming.length > 0) {
        this.outgoing.push(this.incoming.pop()!);
      }
    }
    return this.outgoing.pop();
  }
}

/**
 * 支持异步迭代的通用事件流，并在完成事件到达时解析最终结果。
 */
export class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue = new FifoQueue<T>();
  private waiting = new FifoQueue<(value: IteratorResult<T>) => void>();
  private isDone = false;
  private finalResultPromise: Promise<R>;
  private resolveFinalResult!: (result: R) => void;
  private isComplete: (event: T) => boolean;
  private extractResult: (event: T) => R;

  /**
   * 创建事件流。
   *
   * @param isComplete - 判断事件是否为完成事件；返回 `true` 时事件流不再接收后续事件。
   * @param extractResult - 从完成事件中提取最终结果。
   */
  constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.finalResultPromise = new Promise((resolve: (value: R | PromiseLike<R>) => void): void => {
      this.resolveFinalResult = resolve;
    });
  }

  /**
   * 推送一个事件，优先交给正在等待的消费者，否则放入队列。
   *
   * @param event - 待推送的事件。
   * @remarks 事件流结束后推送的事件会被忽略；推送完成事件时会先标记结束并解析最终结果，完成事件本身仍会被投递。
   */
  push(event: T): void {
    if (this.isDone) {
      return;
    }

    if (this.isComplete(event)) {
      this.isDone = true;
      this.resolveFinalResult(this.extractResult(event));
    }

    // 优先交给等待中的消费者，否则入队。
    const waiter = this.waiting.dequeue();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.enqueue(event);
    }
  }

  /**
   * 结束事件流，并通知所有等待中的消费者迭代结束。
   *
   * @param result - 可选最终结果；提供时用于解析 {@link EventStream.result}，若结果已被解析则不生效。
   * @remarks 队列中已缓存的事件仍会被消费者读取完毕后再结束迭代。
   */
  end(result?: R): void {
    this.isDone = true;
    if (result !== undefined) {
      this.resolveFinalResult(result);
    }
    // 通知所有等待中的消费者，事件流已结束。
    while (this.waiting.length > 0) {
      const waiter = this.waiting.dequeue()!;
      waiter({ value: undefined as T, done: true });
    }
  }

  /**
   * 按推送顺序异步迭代事件。
   *
   * @returns 异步迭代器：先产出已排队事件，队列为空时等待新事件，事件流结束且队列耗尽后完成。
   */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.dequeue()!;
      } else if (this.isDone) {
        return;
      } else {
        const result = await new Promise<IteratorResult<T>>(
          (resolve: (value: PromiseLike<IteratorResult<T>> | IteratorResult<T>) => void): void =>
            this.waiting.enqueue(resolve),
        );
        if (result.done) {
          return;
        }
        yield result.value;
      }
    }
  }

  /**
   * 获取事件流的最终结果。
   *
   * @returns Promise 在完成事件被推送或以结果调用 `end` 后完成，值为最终结果；若事件流以无参 `end()` 结束且未收到完成事件，则该 Promise 永远不会完成。
   */
  result(): Promise<R> {
    return this.finalResultPromise;
  }
}

/**
 * 助手消息事件流，在 done 或 error 事件到达时以对应的助手消息作为最终结果。
 */
export class AssistantMessageEventStream extends EventStream<
  AssistantMessageEvent,
  AssistantMessage
> {
  /** 创建以 done 或 error 事件结算最终助手消息的事件流。 */
  constructor() {
    super(
      (
        event: AssistantMessageEvent,
      ): event is Extract<AssistantMessageEvent, { type: "done" | "error" }> =>
        event.type === "done" || event.type === "error",
      (event: AssistantMessageEvent): AssistantMessage => {
        if (event.type === "done") {
          return event.message;
        } else if (event.type === "error") {
          return event.error;
        }
        throw new Error("Unexpected event type for final result");
      },
    );
  }
}

/**
 * 创建助手消息事件流的工厂函数，供扩展使用。
 *
 * @returns 新的 {@link AssistantMessageEventStream} 实例。
 */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  return new AssistantMessageEventStream();
}
