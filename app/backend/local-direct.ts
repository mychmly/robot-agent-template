import { ModelExecutionResult } from "./model";
import { StructuredResponse, ToolExecutionResult } from "./types";

type LocalDirectInput = {
  routeName: string;
  toolResult?: ToolExecutionResult;
  userMessage?: string;
};

function normalizeText(value: unknown, fallback: string) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || fallback;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return fallback;
}

function buildTimeNowResponse(toolResult: ToolExecutionResult): StructuredResponse {
  const formattedTime = normalizeText(toolResult.output.formatted_time, toolResult.summary);
  const timezone = normalizeText(toolResult.output.timezone, "当前时区");

  return {
    reply: `现在是 ${formattedTime}（${timezone}）。`,
    intent: "回答当前时间查询",
    decision: "直接读取本地系统时钟并返回当前时间",
    action: "输出当前时间信息",
    reason: "该路由已收敛为本地即时值，不需要调用外部 provider，也不需要再经过模型生成。",
    memory_update: "无新增长期记忆"
  };
}

function buildCurrentLocationResponse(toolResult: ToolExecutionResult): StructuredResponse {
  if (toolResult.status === "error") {
    return {
      reply: "我当前无法稳定获取机器人的位置，请稍后重试，或提供巡视画面以触发退化判断。",
      intent: "回答当前位置查询",
      decision: "位置状态源当前不可用",
      action: "提示位置状态暂不可用，并建议补充巡视画面",
      reason: "主位置状态源未返回可用结果，当前不能把不确定位置当成事实。",
      memory_update: "无新增长期记忆"
    };
  }

  const areaName = normalizeText(toolResult.output.area_name, "未知区域");
  const floorName = normalizeText(toolResult.output.floor_name, "未知楼层");
  const signalMode = normalizeText(toolResult.output.signal_mode, "state_mirror");

  return {
    reply: `机器人当前位于 ${floorName}${areaName}。`,
    intent: "回答当前位置查询",
    decision: "直接读取本地位置状态镜像并返回当前区域",
    action: "告知机器人当前所处位置",
    reason: `该路由已命中本地运行时信号，当前位置由 ${signalMode} 提供，不需要再经过模型组织回复。`,
    memory_update: "无新增长期记忆"
  };
}

function buildWeatherResponse(toolResult: ToolExecutionResult): StructuredResponse {
  if (toolResult.status === "error") {
    return {
      reply: "我当前无法稳定获取最新天气信息，请稍后重试。",
      intent: "回答天气查询",
      decision: "天气快照当前不可用",
      action: "提示天气状态暂不可用",
      reason: "天气信号既没有 fresh 快照，也没有可接受的 stale fallback，因此不能给出不可靠天气结论。",
      memory_update: "无新增长期记忆"
    };
  }

  const city = normalizeText(toolResult.output.city, "当前城市");
  const condition = normalizeText(toolResult.output.condition, "天气未知");
  const temperature = normalizeText(toolResult.output.temperature_c, "未知");
  const humidity = normalizeText(toolResult.output.humidity_pct, "未知");
  const signalFreshness = normalizeText(toolResult.output.signal_freshness, "fresh");
  const freshnessPrefix =
    signalFreshness === "stale_fallback"
      ? "当前天气服务暂不可用，以下内容基于最近一次成功获取的天气快照。"
      : "";

  return {
    reply: `${freshnessPrefix}${city} 当前天气为 ${condition}，气温约 ${temperature}°C，湿度 ${humidity}%。`,
    intent: "回答天气查询",
    decision: "直接读取本地天气快照并返回当前天气",
    action: "输出天气、气温和湿度摘要",
    reason:
      signalFreshness === "stale_fallback"
        ? "天气路由当前退化到 stale fallback，但仍优先使用最近一次成功快照，而不重新依赖模型生成。"
        : "天气路由当前命中 fresh 本地快照，因此直接本地直出以降低延迟。",
    memory_update: "无新增长期记忆"
  };
}

function buildHomeEnvironmentResponse(toolResult: ToolExecutionResult): StructuredResponse {
  if (toolResult.status === "error") {
    return {
      reply: "我当前无法稳定获取家庭环境状态，请稍后重试。",
      intent: "回答家庭环境状态查询",
      decision: "家庭环境状态源当前不可用",
      action: "提示环境状态暂不可用",
      reason: "当前没有可用的家庭环境状态镜像，因此不能给出不可靠的环境判断。",
      memory_update: "无新增长期记忆"
    };
  }

  const areaName = normalizeText(toolResult.output.area_name, "当前区域");
  const states =
    toolResult.output.states && typeof toolResult.output.states === "object"
      ? (toolResult.output.states as Record<string, unknown>)
      : {};
  const occupancy = normalizeText(states.occupancy, "未知");
  const door = normalizeText(states.door, "未知");
  const windowState = normalizeText(states.window, "未知");
  const light = normalizeText(states.light, "未知");
  const airConditioner = normalizeText(states.air_conditioner, "未知");
  const temperature = normalizeText(states.temperature_c, "未知");
  const humidity = normalizeText(states.humidity_pct, "未知");

  return {
    reply: `${areaName}当前 occupancy=${occupancy}，door=${door}，window=${windowState}，light=${light}，air_conditioner=${airConditioner}，温度约 ${temperature}°C，湿度 ${humidity}%。`,
    intent: "回答家庭环境状态查询",
    decision: "直接读取本地家庭环境状态镜像并返回摘要",
    action: "输出当前环境状态摘要",
    reason: "该路由已命中本地状态镜像，属于低歧义、可直接本地直出的查询路径。",
    memory_update: "无新增长期记忆"
  };
}

function buildProfileStatementUnconfirmedResponse(userMessage?: string): StructuredResponse {
  const raw = (userMessage || "").trim();
  const normalized = raw.replace(/^(我喜欢|我不喜欢|我希望|我不希望|我更喜欢|我更在意)/, "").trim();
  const subject = normalized ? `“${normalized}”` : "这条偏好表述";

  return {
    reply: `我已理解${subject}。但因为你没有使用“请记住”这类明确授权表达，当前不会把它写入长期记忆或用户画像。当前模板默认关闭自动晋升机制；若你希望我以后稳定参考它，请明确说“请记住：${raw || "你的偏好"}”。后续你们也可以在扩展版本里打开自动晋升开关。`,
    intent: "回应未授权的偏好陈述",
    decision: "不进入长期记忆，也不更新用户画像",
    action: "解释当前只理解偏好表述，但不执行持久化",
    reason: "当前输入属于个人偏好表达，但未显式授权系统长期记住。按照当前模板采用的低频、白名单式用户画像更新原则，以及“自动晋升默认关闭”的策略，本轮只做理解，不做持久化。",
    memory_update: "无新增长期记忆"
  };
}

export function buildLocalDirectResult(input: LocalDirectInput): ModelExecutionResult {
  let structured: StructuredResponse;

  switch (input.routeName) {
    case "tool_time_now":
      if (!input.toolResult) {
        throw new Error("Missing toolResult for local_direct route: tool_time_now");
      }
      structured = buildTimeNowResponse(input.toolResult);
      break;
    case "tool_current_location":
      if (!input.toolResult) {
        throw new Error("Missing toolResult for local_direct route: tool_current_location");
      }
      structured = buildCurrentLocationResponse(input.toolResult);
      break;
    case "tool_weather_lookup":
      if (!input.toolResult) {
        throw new Error("Missing toolResult for local_direct route: tool_weather_lookup");
      }
      structured = buildWeatherResponse(input.toolResult);
      break;
    case "tool_home_environment_status":
      if (!input.toolResult) {
        throw new Error("Missing toolResult for local_direct route: tool_home_environment_status");
      }
      structured = buildHomeEnvironmentResponse(input.toolResult);
      break;
    case "profile_statement_unconfirmed":
      structured = buildProfileStatementUnconfirmedResponse(input.userMessage);
      break;
    default:
      if (!input.toolResult) {
        throw new Error(`Missing toolResult for local_direct route: ${input.routeName}`);
      }
      structured = {
        reply: input.toolResult.summary,
        intent: "回答显式工具查询",
        decision: "直接依据当前本地信号或工具结果返回",
        action: "输出当前查询结果",
        reason: "该路径已被收敛为本地直出或工具结果直出。",
        memory_update: "无新增长期记忆"
      };
      break;
  }

  return {
    structured,
    generationMode: "local_direct"
  };
}
