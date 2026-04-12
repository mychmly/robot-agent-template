import { ExecutionInfo, StructuredResponse } from "./types";

type ExecutionContext = {
  structured: StructuredResponse;
  routeName?: string;
  warning?: string;
};

const HIGH_RISK_KEYWORDS = [
  "高风险",
  "危险",
  "紧急",
  "医疗",
  "婴幼儿",
  "隐私",
  "火灾",
  "燃气",
  "煤气",
  "受伤",
  "流血",
  "报警",
  "求助",
  "立即联系",
  "升级处理"
];

const HUMAN_CONFIRM_KEYWORDS = [
  "人工确认",
  "人工处理",
  "请确认",
  "需要确认",
  "由人确认",
  "转人工",
  "交给人类"
];

const MORE_INFO_KEYWORDS = [
  "信息不足",
  "不确定",
  "无法判断",
  "补充",
  "更多信息",
  "更多视角",
  "重新观察",
  "待确认"
];

const NOTIFY_KEYWORDS = ["提醒", "通知", "告知", "建议先", "建议主人", "主动提醒"];
const NO_OP_KEYWORDS = ["无需提醒", "不提醒", "保持安静", "不打扰", "只更新状态", "继续观察"];

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function includesAny(source: string, keywords: string[]) {
  return keywords.some((keyword) => source.includes(keyword));
}

function buildUtilityNoOpInstruction(routeName?: string) {
  switch (routeName) {
    case "audio_unavailable":
      return "当前音频能力未启用，本轮不触发机器人外部动作。";
    case "profile_capture":
      return "本轮只记录用户明确授权的偏好或背景信息，不触发机器人外部动作。";
    case "profile_statement_unconfirmed":
      return "本轮只理解偏好表述，不执行机器人外部动作，也不写入长期记忆。";
    default:
      return "本轮属于查询、说明或状态型请求，不触发机器人外部动作。";
  }
}

function buildNoOpExecution(instruction: string): ExecutionInfo {
  return {
    action_type: "NO_OP",
    execution_mode: "simulated",
    instruction,
    requires_confirmation: false,
    risk_level: "low"
  };
}

function buildNotifyExecution(instruction: string): ExecutionInfo {
  return {
    action_type: "NOTIFY_USER",
    execution_mode: "simulated",
    instruction,
    requires_confirmation: false,
    risk_level: "low"
  };
}

export function buildExecutionInfo({
  structured,
  routeName,
  warning
}: ExecutionContext): ExecutionInfo {
  const joined = normalizeText(
    [structured.decision, structured.action, structured.reason, warning || ""].join(" ")
  ).toLowerCase();

  const utilityRoutes = new Set([
    "audio_unavailable",
    "greeting_status",
    "profile_capture",
    "profile_statement_unconfirmed"
  ]);

  if (routeName && (routeName.startsWith("tool_") || utilityRoutes.has(routeName))) {
    return buildNoOpExecution(buildUtilityNoOpInstruction(routeName));
  }

  if (includesAny(joined, HIGH_RISK_KEYWORDS.map((item) => item.toLowerCase()))) {
    return {
      action_type: "ESCALATE_TO_HUMAN",
      execution_mode: "human_proxy",
      instruction: "当前判断已触及高风险或边界外场景，应立即转交人类确认与处理。",
      requires_confirmation: true,
      risk_level: "high"
    };
  }

  if (includesAny(joined, HUMAN_CONFIRM_KEYWORDS.map((item) => item.toLowerCase()))) {
    return {
      action_type: "ASK_HUMAN_CONFIRM",
      execution_mode: "human_proxy",
      instruction:
        normalizeText(structured.action) || "当前建议需要先由人类确认，再决定是否继续推进。",
      requires_confirmation: true,
      risk_level: "medium"
    };
  }

  if (includesAny(joined, MORE_INFO_KEYWORDS.map((item) => item.toLowerCase()))) {
    return {
      action_type: "REQUEST_MORE_INFO",
      execution_mode: "simulated",
      instruction:
        normalizeText(structured.action) || "请补充更多信息、更多视角或更清晰的输入后再继续判断。",
      requires_confirmation: false,
      risk_level: "low"
    };
  }

  if (includesAny(joined, NOTIFY_KEYWORDS.map((item) => item.toLowerCase()))) {
    return {
      action_type: "NOTIFY_USER",
      execution_mode: "simulated",
      instruction:
        normalizeText(structured.action) || "向用户发送一条简洁、低打扰的提醒信息。",
      requires_confirmation: false,
      risk_level: "low"
    };
  }

  if (includesAny(joined, NO_OP_KEYWORDS.map((item) => item.toLowerCase()))) {
    return buildNoOpExecution(
      normalizeText(structured.action) || "本轮保持安静，不触发机器人外部动作。"
    );
  }

  if (normalizeText(structured.action)) {
    return buildNotifyExecution(normalizeText(structured.action));
  }

  return buildNoOpExecution("本轮未形成明确执行动作，先保持当前状态。");
}
