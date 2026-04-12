import { ResolvedContextBundle } from "./context-routing";
import { StructuredResponse, ToolExecutionResult } from "./types";

type UploadPayload = {
  message: string;
  imageDataUrls: string[];
  audioNames: string[];
};

export type ResponseBuildMode = "model" | "tool_fallback" | "local_direct";

export type ModelExecutionResult = {
  structured: StructuredResponse;
  generationMode: ResponseBuildMode;
};

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

function stripCodeFences(value: string) {
  return value
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractJsonBlock(value: string) {
  const cleaned = stripCodeFences(value);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model response did not include a JSON object.");
  }

  return cleaned.slice(start, end + 1);
}

function normalizeTextField(value: unknown, fallback: string) {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || fallback;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    const normalized = JSON.stringify(value);
    return normalized?.trim() || fallback;
  }

  return fallback;
}

function normalizeStructuredResponse(value: Partial<StructuredResponse>): StructuredResponse {
  return {
    reply: normalizeTextField(value.reply, "未生成回复。"),
    intent: normalizeTextField(value.intent, "未识别"),
    decision: normalizeTextField(value.decision, "未生成"),
    action: normalizeTextField(value.action, "未生成"),
    reason: normalizeTextField(value.reason, "未生成"),
    memory_update: normalizeTextField(value.memory_update, "无新增记忆")
  };
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function formatSourceCount(sources?: ToolExecutionResult["sources"]) {
  return sources?.length ? `${sources.length} 条` : "0 条";
}

function buildToolFallbackResponse(toolResult: ToolExecutionResult): StructuredResponse {
  const cacheStatus =
    typeof toolResult.output.cache_status === "string" ? toolResult.output.cache_status : "";

  switch (toolResult.toolName) {
    case "time_now": {
      const formattedTime = normalizeTextField(
        toolResult.output.formatted_time,
        toolResult.summary
      );
      const timezone = normalizeTextField(toolResult.output.timezone, "当前时区");

      return normalizeStructuredResponse({
        reply: `现在是 ${formattedTime}（${timezone}）。`,
        intent: "回答当前时间查询",
        decision: "直接依据系统时钟返回当前时间",
        action: "输出当前时间信息并保持简洁说明",
        reason: "显性路由已命中 time_now，系统时钟结果稳定且无需额外推断。",
        memory_update: "无新增长期记忆"
      });
    }
    case "current_location": {
      const areaName = normalizeTextField(toolResult.output.area_name, "未知区域");
      const floorName = normalizeTextField(toolResult.output.floor_name, "未知楼层");
      const sourceType = normalizeTextField(toolResult.output.source_type, "location_feed");

      return normalizeStructuredResponse({
        reply: `机器人当前位于 ${floorName}${areaName}。`,
        intent: "回答当前位置查询",
        decision: "直接依据当前位置工具结果返回区域信息",
        action: "告知机器人当前位置并保留来源类型说明",
        reason: `显性路由已命中 current_location，当前定位来源为 ${sourceType}。`,
        memory_update: "无新增长期记忆"
      });
    }
    case "weather_lookup": {
      const city = normalizeTextField(toolResult.output.city, "当前城市");
      const condition = normalizeTextField(toolResult.output.condition, "天气未知");
      const temperature = normalizeTextField(toolResult.output.temperature_c, "未知");
      const staleSuffix =
        cacheStatus === "stale_fallback"
          ? "当前外部天气服务暂不可用，以下内容基于最近一次成功获取的缓存结果。"
          : "";

      return normalizeStructuredResponse({
        reply: `${staleSuffix}${city} 当前天气为 ${condition}，气温约 ${temperature}°C。`,
        intent: "回答天气查询",
        decision: "直接依据天气工具结果返回当前天气",
        action: "输出天气与气温信息，不扩写额外推断",
        reason:
          cacheStatus === "stale_fallback"
            ? "weather_lookup 当前使用最近一次成功结果作为退化回退，以保证课堂演示稳定。"
            : "显性路由已命中 weather_lookup，工具已返回当前天气数据。",
        memory_update: "无新增长期记忆"
      });
    }
    case "home_environment_status": {
      const areaName = normalizeTextField(toolResult.output.area_name, "当前区域");
      const states =
        toolResult.output.states && typeof toolResult.output.states === "object"
          ? (toolResult.output.states as Record<string, unknown>)
          : {};
      const occupancy = normalizeTextField(states.occupancy, "未知");
      const door = normalizeTextField(states.door, "未知");
      const windowState = normalizeTextField(states.window, "未知");
      const temperature = normalizeTextField(states.temperature_c, "未知");

      return normalizeStructuredResponse({
        reply: `${areaName}当前 occupancy=${occupancy}，door=${door}，window=${windowState}，温度约 ${temperature}°C。`,
        intent: "回答家庭环境状态查询",
        decision: "直接依据家庭环境状态工具结果返回当前状态",
        action: "输出当前区域状态摘要并保留教学可解释性",
        reason: "显性路由已命中 home_environment_status，当前回复基于本地环境状态源。",
        memory_update: "无新增长期记忆"
      });
    }
    case "web_search": {
      const query = normalizeTextField(toolResult.output.query, "当前问题");
      const sourceCount = formatSourceCount(toolResult.sources);
      const cachePrefix =
        cacheStatus === "stale_fallback"
          ? "当前检索服务暂不可用，以下来源来自最近一次成功缓存。"
          : cacheStatus === "fresh_cache"
            ? "已直接复用最近一次成功检索结果。"
            : "";

      return normalizeStructuredResponse({
        reply: `${cachePrefix}我已围绕“${query}”整理出 ${sourceCount} 可溯源网页来源，来源链接已附在当前工具区，可继续让我基于这些来源做简要整理。`,
        intent: "回答显式联网检索请求",
        decision: "直接基于检索工具结果返回来源集合",
        action: "展示来源链接并允许用户继续追问",
        reason:
          cacheStatus === "stale_fallback"
            ? "web_search 当前退化为最近一次成功缓存，以保证课堂演示的稳定性。"
            : "显性路由已命中 web_search，当前回复基于受控检索结果生成。",
        memory_update: "无新增长期记忆"
      });
    }
    default:
      return normalizeStructuredResponse({
        reply: toolResult.summary,
        intent: "回答工具查询",
        decision: "直接依据工具结果返回",
        action: "输出工具摘要",
        reason: "当前路由已命中工具子链，优先保证回复稳定。",
        memory_update: "无新增长期记忆"
      });
  }
}

function buildSystemPrompt(
  contextBundle: ResolvedContextBundle,
  toolResult?: ToolExecutionResult
) {
  const contextBlocks = contextBundle.blocks
    .map((block) => `[${block.label}]\n${block.content}`)
    .join("\n\n");

  const rationale = contextBundle.rationale.map((item) => `- ${item}`).join("\n");

  const toolBlock = toolResult
    ? `

本轮已执行外部工具：${toolResult.toolName}
工具状态：${toolResult.status}
工具摘要：${toolResult.summary}
工具来源：${toolResult.sourceLabel}

[tool_output]
${JSON.stringify(toolResult.output, null, 2)}

${toolResult.sources?.length ? `[tool_sources]\n${toolResult.sources.map((item, index) => `${index + 1}. ${item.title} | ${item.url}`).join("\n")}` : ""}
`
    : "";

  return `你是一个基于本地 Markdown 文件系统运行的 robot-agent。

本轮已命中路由：${contextBundle.routeName}（${contextBundle.description}）

路由依据：
${rationale}

请严格只依据以下已披露的本地文档与摘录进行判断，不要假设自己还读取了其他未提供的文件：

${contextBlocks}
${toolBlock}

请遵守以下输出要求：
1. 不要输出 Markdown。
2. 只输出合法 JSON。
3. JSON 必须包含以下字段：
   - reply
   - intent
   - decision
   - action
   - reason
   - memory_update
4. 所有字段的值都必须是字符串，不要返回数组、对象、数字或布尔值。
5. reply 必须是简洁中文解释。
6. memory_update 只用于描述“适合进入长期记忆的稳定信息”。
7. 如果本轮没有新增长期记忆，请严格输出：无新增长期记忆。
8. 当信息不足时，必须在 reply 和 reason 中明确写出不确定性。
9. 不要假装你看到了图片中不存在的内容，也不要假装你听到了未被成功转写的音频内容。
10. 文本默认优先理解为系统事件说明；但如果当前路由表明这是问候、状态试探、工具查询或对上一轮的追问，可以自然地按该路由回复。
11. 若本轮已执行外部工具，reply 和 reason 必须优先依据工具结果组织，不要绕开工具结果去凭空补充。`;
}

function buildUserText(payload: UploadPayload) {
  const lines: string[] = [];

  if (payload.message.trim()) {
    lines.push(payload.message.trim());
  } else if (payload.imageDataUrls.length > 0) {
    lines.push(
      "系统事件：机器人刚完成一次家庭公共区域巡视。当前仅提供了一张巡视图片，请判断是否需要主动提醒主人。"
    );
  } else {
    lines.push("系统事件：机器人刚完成一次巡视，请根据当前输入判断下一步。");
  }

  if (payload.imageDataUrls.length > 0) {
    lines.push(`附加信号：当前检测到 ${payload.imageDataUrls.length} 张巡视图片。`);
  }

  if (payload.audioNames.length > 0) {
    lines.push(
      `附加信号：当前检测到 ${payload.audioNames.length} 个音频文件（${payload.audioNames.join(
        "、"
      )}）。当前系统默认未启用音频转写与理解能力，请基于这一事实真实回复，不要假装已经理解音频内容。`
    );
  }

  return lines.join("\n");
}

export async function requestModel(
  payload: UploadPayload,
  contextBundle: ResolvedContextBundle,
  toolResult?: ToolExecutionResult,
  signal?: AbortSignal
): Promise<ModelExecutionResult> {
  const baseUrl = process.env.BASE_URL?.trim() || DEFAULT_BASE_URL;
  const apiKey = process.env.API_KEY?.trim();
  const model = process.env.MODEL?.trim();

  if (!apiKey) {
    throw new Error("Missing API_KEY in .env.");
  }

  if (!model) {
    throw new Error("Missing MODEL in .env.");
  }

  const userContent: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: buildUserText(payload)
    }
  ];

  for (const imageDataUrl of payload.imageDataUrls) {
    userContent.push({
      type: "image_url",
      image_url: {
        url: imageDataUrl
      }
    });
  }

  const requestBody: Record<string, unknown> = {
    model,
    temperature:
      typeof contextBundle.modelOptions?.temperature === "number"
        ? contextBundle.modelOptions.temperature
        : 0.3,
    max_tokens:
      typeof contextBundle.modelOptions?.maxTokens === "number"
        ? contextBundle.modelOptions.maxTokens
        : 450,
    messages: [
      {
        role: "system",
        content: buildSystemPrompt(contextBundle, toolResult)
      },
      {
        role: "user",
        content: userContent
      }
    ]
  };

  if (typeof contextBundle.modelOptions?.enableThinking === "boolean") {
    requestBody.enable_thinking = contextBundle.modelOptions.enableThinking;
  }

  if (typeof contextBundle.modelOptions?.thinkingBudget === "number") {
    requestBody.thinking_budget = contextBundle.modelOptions.thinkingBudget;
  }

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Model request failed with status ${response.status}: ${errorText.slice(0, 400)}`
      );
    }

    const data = await response.json();
    const rawContent =
      data?.choices?.[0]?.message?.content ||
      data?.choices?.[0]?.message?.reasoning_content ||
      "";

    if (!rawContent || typeof rawContent !== "string") {
      throw new Error("Model response did not include message content.");
    }

    const parsed = JSON.parse(extractJsonBlock(rawContent));
    return {
      structured: normalizeStructuredResponse(parsed),
      generationMode: "model"
    };
  } catch (error) {
    if (toolResult && !isAbortError(error)) {
      console.warn(
        `[teacher-pilot][tool-response-fallback] route=${contextBundle.routeName} tool=${toolResult.toolName}`
      );
      return {
        structured: buildToolFallbackResponse(toolResult),
        generationMode: "tool_fallback"
      };
    }

    throw error;
  }
}
