/**
 * 返回应用启动时的问候语。
 *
 * @param name - 要问候的名称，默认为 "World"
 * @returns 格式化后的问候字符串
 */
function greet(name: string = "World"): string {
  return `Hello ${name}!`;
}

/**
 * 应用入口，向控制台输出问候语。
 */
function main(): void {
  console.log(greet());
}

main();

export { greet };
