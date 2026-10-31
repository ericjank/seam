import { parse } from "yaml";

export function parseStructuredContent(content: string): unknown {
  return parse(content);
}

export function validateArtifact(type: string, content: string) {
  if (["openapi", "asyncapi", "json-schema"].includes(type)) {
    const value = parseStructuredContent(content) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("契约必须是结构化对象");
    if (type === "openapi" && !("openapi" in value)) throw new Error("OpenAPI 文档缺少 openapi 版本字段");
    if (type === "asyncapi" && !("asyncapi" in value)) throw new Error("AsyncAPI 文档缺少 asyncapi 版本字段");
    if (type === "json-schema" && !("$schema" in value) && !("type" in value)) {
      throw new Error("JSON Schema 至少需要 $schema 或 type 字段");
    }
  }
}

export function analyzeContractDiff(previous: string, next: string) {
  const before = parseStructuredContent(previous) as Record<string, unknown>;
  const after = parseStructuredContent(next) as Record<string, unknown>;
  const warnings: string[] = [];
  const beforePaths = recordPaths(before.paths);
  const afterPaths = recordPaths(after.paths);
  for (const path of beforePaths) {
    if (!afterPaths.includes(path)) warnings.push(`删除接口路径：${path}`);
  }
  const beforeSchemas = recordPaths(recordValue(before.components)?.schemas);
  const afterSchemas = recordPaths(recordValue(after.components)?.schemas);
  for (const schema of beforeSchemas) {
    if (!afterSchemas.includes(schema)) warnings.push(`删除数据模型：${schema}`);
  }
  return warnings;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function recordPaths(value: unknown) {
  return Object.keys(recordValue(value) ?? {});
}
