import { describe, it, expect } from "vitest";
import { z } from "zod";
import { completeStructured, extractJson, formatValidationIssues } from "@/lib/llm/structured";
import { FakeProvider } from "@/lib/llm/fake";
import { StructuredOutputError } from "@/lib/llm/types";

const PageSchema = z.object({
  title: z.string(),
  type: z.enum(["entity", "concept"]),
  summary: z.string(),
});

describe("extractJson —— 从模型输出里抠 JSON", () => {
  it("直接是 JSON", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it("markdown 围栏包裹", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("前后有解释文字", () => {
    expect(extractJson('好的，这是结果：\n{"a":1}\n希望有帮助。')).toBe('{"a":1}');
  });

  it("嵌套对象", () => {
    expect(extractJson('{"a":{"b":{"c":1}}}')).toBe('{"a":{"b":{"c":1}}}');
  });

  it("数组", () => {
    expect(extractJson('[1,2,3]')).toBe("[1,2,3]");
  });

  it("字符串里的括号不干扰平衡扫描", () => {
    expect(extractJson('{"a":"包含 } 和 { 的字符串"}')).toBe('{"a":"包含 } 和 { 的字符串"}');
  });

  it("字符串里的转义引号不干扰", () => {
    const text = '{"a":"他说：\\"你好\\""}';
    expect(extractJson(text)).toBe(text);
  });

  it("中文内容", () => {
    expect(extractJson('{"标题":"张一鸣"}')).toBe('{"标题":"张一鸣"}');
  });

  it("完全不是 JSON 时返回 null", () => {
    expect(extractJson("我不知道该怎么回答")).toBeNull();
  });

  it("未闭合的 JSON 返回 null", () => {
    expect(extractJson('{"a":1')).toBeNull();
  });
});

describe("completeStructured —— 一次成功", () => {
  it("返回校验通过的对象", async () => {
    const provider = new FakeProvider({
      responses: ['{"title":"张一鸣","type":"entity","summary":"字节跳动创始人"}'],
    });

    const result = await completeStructured({
      provider,
      schema: PageSchema,
      schemaName: "page",
      messages: [{ role: "user", content: "整理这份资料" }],
    });

    expect(result.data.title).toBe("张一鸣");
    expect(result.attempts).toBe(1);
  });

  it("容忍 markdown 围栏", async () => {
    const provider = new FakeProvider({
      responses: ['```json\n{"title":"甲","type":"concept","summary":"说明"}\n```'],
    });
    const result = await completeStructured({
      provider, schema: PageSchema, schemaName: "page",
      messages: [{ role: "user", content: "x" }],
    });
    expect(result.data.title).toBe("甲");
    expect(result.attempts).toBe(1);
  });
});

describe("completeStructured —— 校验失败后重试", () => {
  it("字段类型错时重试并成功", async () => {
    const provider = new FakeProvider({
      responses: [
        '{"title":"甲","type":"不存在的类型","summary":"说明"}',
        '{"title":"甲","type":"entity","summary":"说明"}',
      ],
    });

    const result = await completeStructured({
      provider, schema: PageSchema, schemaName: "page",
      messages: [{ role: "user", content: "x" }],
    });

    expect(result.attempts).toBe(2);
    expect(result.data.type).toBe("entity");
  });

  it("把具体的校验错误回填给模型，而不是原样重试", async () => {
    const provider = new FakeProvider({
      responses: [
        '{"title":"甲","type":"错","summary":"说明"}',
        '{"title":"甲","type":"entity","summary":"说明"}',
      ],
    });

    await completeStructured({
      provider, schema: PageSchema, schemaName: "page",
      messages: [{ role: "user", content: "x" }],
    });

    const retryMessages = provider.calls[1].messages;
    const feedback = retryMessages.map((m) => m.content).join("\n");
    expect(feedback).toContain("type");
    expect(feedback).toContain("不符合结构要求");
  });

  it("JSON 语法错误时重试", async () => {
    const provider = new FakeProvider({
      responses: [
        '{"title":"甲","type":"entity",,}',
        '{"title":"甲","type":"entity","summary":"说明"}',
      ],
    });
    const result = await completeStructured({
      provider, schema: PageSchema, schemaName: "page",
      messages: [{ role: "user", content: "x" }],
    });
    expect(result.attempts).toBe(2);
  });

  it("输出被截断时要求更精简并重试", async () => {
    const provider = new FakeProvider({
      responses: [
        { text: '{"title":"甲","type":"ent', truncated: true },
        '{"title":"甲","type":"entity","summary":"说明"}',
      ],
    });
    const result = await completeStructured({
      provider, schema: PageSchema, schemaName: "page",
      messages: [{ role: "user", content: "x" }],
    });
    expect(result.attempts).toBe(2);
    expect(provider.calls[1].messages.map((m) => m.content).join("\n")).toContain("截断");
  });

  it("重试时温度降到 0 —— 减少二次随机性", async () => {
    const provider = new FakeProvider({
      responses: [
        '{"title":"甲","type":"错","summary":"说明"}',
        '{"title":"甲","type":"entity","summary":"说明"}',
      ],
    });
    await completeStructured({
      provider, schema: PageSchema, schemaName: "page",
      messages: [{ role: "user", content: "x" }],
    });
    expect(provider.calls[0].temperature).not.toBe(0);
    expect(provider.calls[1].temperature).toBe(0);
  });

  it("连续失败时抛出带诊断信息的错误", async () => {
    const provider = new FakeProvider({ fallback: "这不是 JSON" });

    await expect(
      completeStructured({
        provider, schema: PageSchema, schemaName: "page",
        messages: [{ role: "user", content: "x" }], maxAttempts: 2,
      }),
    ).rejects.toThrow(StructuredOutputError);

    try {
      await completeStructured({
        provider, schema: PageSchema, schemaName: "page",
        messages: [{ role: "user", content: "x" }], maxAttempts: 2,
      });
    } catch (error) {
      const e = error as StructuredOutputError;
      expect(e.attempts).toBe(2);
      expect(e.lastRaw).toBeTruthy();
    }
  });

  it("每次失败都通过 onAttempt 上报，供前端展示进度", async () => {
    const provider = new FakeProvider({ fallback: "坏的" });
    const attempts: number[] = [];

    await expect(
      completeStructured({
        provider, schema: PageSchema, schemaName: "page",
        messages: [{ role: "user", content: "x" }], maxAttempts: 3,
        onAttempt: (n) => attempts.push(n),
      }),
    ).rejects.toThrow();

    expect(attempts).toEqual([1, 2, 3]);
  });
});

describe("completeStructured —— 严格 Schema 模式", () => {
  it("provider 支持时走 json_schema 路径", async () => {
    const provider = new FakeProvider({
      responses: ['{"title":"甲","type":"entity","summary":"说明"}'],
      supportsStrictSchema: true,
    });
    const result = await completeStructured({
      provider, schema: PageSchema, schemaName: "page",
      messages: [{ role: "user", content: "x" }],
    });

    expect(result.usedStrictSchema).toBe(true);
    expect(provider.calls[0].responseFormat?.type).toBe("json_schema");
  });

  it("不支持时降级为 json_object 并补一条格式指令", async () => {
    const provider = new FakeProvider({
      responses: ['{"title":"甲","type":"entity","summary":"说明"}'],
      supportsStrictSchema: false,
    });
    const result = await completeStructured({
      provider, schema: PageSchema, schemaName: "page",
      messages: [{ role: "user", content: "x" }],
    });

    expect(result.usedStrictSchema).toBe(false);
    expect(provider.calls[0].responseFormat?.type).toBe("json_object");
    expect(provider.calls[0].messages.some((m) => m.content.includes("只返回一个 JSON 对象"))).toBe(true);
  });

  it("非严格模式下，**第一次**调用就带上完整字段清单", async () => {
    // 回归用例：早先只在重试 prompt 里补 schema，于是「第一次调用」模型只能看到
    // 「输出 JSON」四个字 —— 端点不支持 response_format 时（opencode go 网关就是），
    // 它会自创一套顶层键名，校验必然失败，第二次拿到 schema 才通过。
    // 用户看到的就是「每次导入都失败一次、重试一下又好了」，代价是每次白等一整轮
    // max 思考档的调用。
    const provider = new FakeProvider({
      responses: ['{"title":"甲","type":"entity","summary":"说明"}'],
      supportsStrictSchema: false,
    });
    const result = await completeStructured({
      provider, schema: PageSchema, schemaName: "page",
      messages: [{ role: "user", content: "x" }],
    });

    expect(result.attempts).toBe(1);
    const system = provider.calls[0].messages.find((m) => m.role === "system");
    expect(system?.content).toContain("只返回一个 JSON 对象");
    expect(system?.content).toContain("title");
    expect(system?.content).toContain("summary");
    expect(system?.content).toContain("entity");
  });

  it("严格模式下不重复塞字段清单 —— 约束已经由服务商保证", async () => {
    const provider = new FakeProvider({
      responses: ['{"title":"甲","type":"entity","summary":"说明"}'],
      supportsStrictSchema: true,
    });
    await completeStructured({
      provider, schema: PageSchema, schemaName: "page",
      messages: [{ role: "user", content: "x" }],
    });

    expect(provider.calls[0].messages.some((m) => m.role === "system")).toBe(false);
  });

  it("timeoutMs 一路传到 provider —— 后台任务可以要一个更长的超时", async () => {
    // 回归用例：这个选项曾经声明了却从不往下传，于是「让导入等久一点」只是
    // 一句写在类型里的愿望，实际永远吃 provider 的默认值（5 分钟），
    // 一份 16KB 的资料就是这样在起草到一半被掐断的。
    const provider = new FakeProvider({
      responses: ['{"title":"甲","type":"entity","summary":"说明"}'],
    });
    await completeStructured({
      provider, schema: PageSchema, schemaName: "page",
      messages: [{ role: "user", content: "x" }],
      timeoutMs: 900_000,
    });

    expect(provider.calls[0].timeoutMs).toBe(900_000);
  });

  it("严格模式生成的 JSON Schema 含枚举约束", async () => {
    const provider = new FakeProvider({
      responses: ['{"title":"甲","type":"entity","summary":"说明"}'],
      supportsStrictSchema: true,
    });
    await completeStructured({
      provider, schema: PageSchema, schemaName: "page",
      messages: [{ role: "user", content: "x" }],
    });

    const format = provider.calls[0].responseFormat;
    expect(format?.type).toBe("json_schema");
    if (format?.type === "json_schema") {
      const schema = format.json_schema.schema as { properties?: Record<string, { enum?: string[] }> };
      expect(schema.properties?.type?.enum).toEqual(["entity", "concept"]);
    }
  });
});

describe("formatValidationIssues", () => {
  it("把 Zod 错误整理成中文说明", () => {
    const result = PageSchema.safeParse({ title: "甲", type: "错", summary: "说明" });
    expect(result.success).toBe(false);
    if (result.success) return;
    const text = formatValidationIssues(result.error);
    expect(text).toContain("type");
  });
});

describe("传输失败自动重试", () => {
  it("短暂连接故障后成功，不把网络错误当成 JSON 校验失败", async () => {
    const provider = new FakeProvider({ responses: [{ error: 'offline', retryable: true }, '{"title":"甲","type":"entity","summary":"说明"}'] });
    const result = await completeStructured({ provider, schema: PageSchema, schemaName: 'page', messages: [{ role: 'user', content: 'x' }] });
    expect(result.attempts).toBe(1); expect(provider.calls).toHaveLength(2);
  });
  it("不可重试错误立即返回", async () => {
    const provider = new FakeProvider({ responses: [{ error: 'authentication', retryable: false }] });
    await expect(completeStructured({ provider, schema: PageSchema, schemaName: 'page', messages: [] })).rejects.toThrow('authentication');
    expect(provider.calls).toHaveLength(1);
  });
});
