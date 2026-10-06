import { readdir, readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import typescriptPlugin from "prettier/plugins/typescript";

const PROJECT_DIRECTORY = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const CALL_TYPES = new Set(["CallExpression", "NewExpression"]);
const CAMEL_CASE = /^[a-z][A-Za-z0-9]*$/;
const BOOLEAN_PREFIX = /^(?:is|has|can|should|supports|requires|allows|needs)[A-Z]/;

/** 提取 AST 子节点，跳过位置数据、注释和重复元数据。 */
function childNodes(node) {
  return Object.entries(node)
    .filter(([key]) => !["loc", "range", "comments", "tokens", "parent"].includes(key))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter((value) => value && typeof value === "object" && typeof value.type === "string");
}

/** 计算表达式的实际调用嵌套层数；匿名函数体单独检查。 */
function callDepth(node) {
  if (FUNCTION_TYPES.has(node.type)) {
    return 0;
  }
  const depths = childNodes(node).map(callDepth);
  const childDepth = Math.max(0, ...depths);
  return childDepth + (CALL_TYPES.has(node.type) ? 1 : 0);
}

/** 获取参数声明，不推测解构模式中的字段名。 */
function parameterDeclaration(parameter) {
  if (parameter.type === "TSParameterProperty") {
    return parameterDeclaration(parameter.parameter);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.left;
  }
  return parameter;
}

/** 获取紧邻声明的 TSDoc，避免误用外层函数的文档。 */
function declarationDoc(node, comments, source) {
  const comment = comments.findLast(
    (value) =>
      value.type === "Block" && value.value.startsWith("*") && value.range[1] <= node.range[0],
  );
  if (!comment || source.slice(comment.range[1], node.range[0]).trim() !== "") {
    return undefined;
  }
  return comment.value;
}

/** 根据声明结构确定函数名、注释载体和是否必须提供文档。 */
function functionDeclaration(node, ancestors) {
  const parent = ancestors.at(-1);
  const grandparent = ancestors.at(-2);
  if (parent?.type === "VariableDeclarator") {
    const statement = grandparent;
    const exportDeclaration = ancestors.at(-3);
    return {
      name: parent.id.type === "Identifier" ? parent.id.name : undefined,
      host: exportDeclaration?.type === "ExportNamedDeclaration" ? exportDeclaration : statement,
      needsDoc: true,
    };
  }
  if (parent?.type === "Property") {
    return {
      name: !parent.computed && parent.key.type === "Identifier" ? parent.key.name : undefined,
      host: parent,
      needsDoc: true,
    };
  }
  if (parent?.type === "MethodDefinition") {
    const classBody = grandparent;
    const classDeclaration = ancestors.at(-3);
    const exportDeclaration = ancestors.at(-4);
    const isExportedClass =
      classBody?.type === "ClassBody" &&
      classDeclaration?.type === "ClassDeclaration" &&
      exportDeclaration?.type === "ExportNamedDeclaration";
    return {
      name:
        !parent.computed && parent.key.type === "Identifier" && parent.kind !== "constructor"
          ? parent.key.name
          : undefined,
      host: parent,
      needsDoc: isExportedClass && parent.accessibility !== "private",
    };
  }
  return {
    name: node.id?.name,
    host: parent?.type === "ExportNamedDeclaration" ? parent : node,
    needsDoc: parent?.type === "ExportNamedDeclaration",
  };
}

/** 检查中文 TSDoc 的参数与返回说明，代码标识符保持原样。 */
function checkDoc(node, declaration, comments, source, report) {
  if (!declaration.needsDoc) {
    return;
  }
  const doc = declarationDoc(declaration.host, comments, source);
  if (!doc) {
    report(declaration.host, "函数缺少 TSDoc 文档注释");
    return;
  }
  const description = doc.split(/@\w+/)[0];
  if (!/[\u4e00-\u9fff]/.test(description)) {
    report(declaration.host, "TSDoc 首段缺少中文职责说明");
  }
  const tags = [...doc.matchAll(/@param\s+(\S+)\s+-\s+([^@]*)/g)];
  for (const parameter of node.params) {
    const value = parameterDeclaration(parameter);
    const name = value.type === "Identifier" ? value.name : source.slice(...value.range);
    const tag = tags.find((entry) => entry[1] === name);
    if (!tag || !/[\u4e00-\u9fff]/.test(tag[2])) {
      report(declaration.host, `TSDoc 缺少参数 ${name} 的中文说明`);
    }
  }
  const returnType = node.returnType?.typeAnnotation;
  if (
    returnType &&
    returnType.type !== "TSVoidKeyword" &&
    !(returnType.type === "TSTypePredicate" && returnType.asserts) &&
    !/@returns\s+[^@]*[\u4e00-\u9fff]/.test(doc)
  ) {
    report(declaration.host, "TSDoc 缺少中文 @returns 说明");
  }
}

/** 检查单个源码文件的明确规则，并返回定位准确的诊断。 */
async function checkSourceFile(file) {
  const source = await readFile(file, "utf8");
  const ast = await typescriptPlugin.parsers.typescript.parse(source);
  const diagnostics = [];
  const displayPath = relative(PROJECT_DIRECTORY, file);
  const report = (node, message) => {
    diagnostics.push(`${displayPath}:${node.loc.start.line} ${message}`);
  };
  const visit = (node, ancestors = []) => {
    const parent = ancestors.at(-1);
    if (node.type === "IfStatement") {
      if (node.consequent.type !== "BlockStatement") {
        report(node, "判断分支必须保留大括号");
      }
      if (node.alternate && !["BlockStatement", "IfStatement"].includes(node.alternate.type)) {
        report(node.alternate, "else 分支必须保留大括号");
      }
    }
    if (
      [
        "ForStatement",
        "ForOfStatement",
        "ForInStatement",
        "WhileStatement",
        "DoWhileStatement",
      ].includes(node.type) &&
      node.body.type !== "BlockStatement"
    ) {
      report(node, "循环代码块必须保留大括号");
    }
    if (CALL_TYPES.has(node.type)) {
      const depth = callDepth(node);
      if (depth > 2) {
        report(node, `方法调用嵌套为 ${depth} 层，最多允许 2 层`);
      }
    }
    if (FUNCTION_TYPES.has(node.type)) {
      for (const parameter of node.params) {
        const value = parameterDeclaration(parameter);
        if (!value.typeAnnotation) {
          report(value, "函数参数必须显式标注类型");
        }
      }
      const isConstructor = parent?.type === "MethodDefinition" && parent.kind === "constructor";
      if (!node.returnType && !isConstructor) {
        report(node, "函数必须显式标注返回类型");
      }
      const declaration = functionDeclaration(node, ancestors);
      if (declaration.name && !CAMEL_CASE.test(declaration.name)) {
        report(declaration.host, `函数 ${declaration.name} 必须使用 camelCase`);
      }
      checkDoc(node, declaration, ast.comments ?? [], source, report);
    }
    if (node.type === "PropertyDefinition" && !node.computed && node.key.type === "Identifier") {
      const isBoolean =
        node.typeAnnotation?.typeAnnotation.type === "TSBooleanKeyword" ||
        (node.value?.type === "Literal" && typeof node.value.value === "boolean");
      if (isBoolean && !BOOLEAN_PREFIX.test(node.key.name)) {
        report(node, `布尔字段 ${node.key.name} 必须使用表示判断的前缀`);
      }
    }
    const nextAncestors = [...ancestors, node];
    for (const child of childNodes(node)) {
      visit(child, nextAncestors);
    }
  };
  visit(ast);
  return diagnostics;
}

/** 验证全部项目源码；存在违反规则的声明时以非零退出码结束。 */
async function main() {
  const directory = resolve(PROJECT_DIRECTORY, "src");
  const entries = await readdir(directory, { recursive: true });
  const files = entries.filter((entry) => /\.(?:ts|tsx)$/.test(entry));
  const results = await Promise.all(
    files.map((entry) => checkSourceFile(resolve(directory, entry))),
  );
  const diagnostics = results.flat();
  if (diagnostics.length > 0) {
    console.error(diagnostics.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`源码规范检查通过：${files.length} 个文件。`);
}

const ENTRY_URL = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (import.meta.url === ENTRY_URL) {
  await main();
}
