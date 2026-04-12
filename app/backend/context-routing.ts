import path from "path";
import {
  readMarkdown,
  readMarkdownSections,
  readRecentInteractionsExcerpt
} from "./markdown";
import { RuntimeSignalKey, ToolName } from "./types";

type UploadPayload = {
  message: string;
  imageDataUrls: string[];
  audioNames: string[];
};

type ContextSpec = {
  path: string;
  sections?: string[];
  recentTurns?: number;
};

type RouteMatch = {
  hasImages?: boolean;
  hasAudio?: boolean;
  audioEnabled?: boolean;
  keywordsAny?: string[];
  keywordsAll?: string[];
  keywordsNone?: string[];
  startsWithAny?: string[];
  startsWithNone?: string[];
  questionLike?: boolean;
  followUp?: boolean;
  default?: boolean;
};

type ModelOptions = {
  enableThinking?: boolean;
  thinkingBudget?: number;
  maxTokens?: number;
  temperature?: number;
};

type RouteDefinition = {
  name: string;
  description: string;
  priority: number;
  warning?: string;
  toolName?: ToolName;
  signalKey?: RuntimeSignalKey;
  responseMode?: "model" | "local_direct";
  match: RouteMatch;
  include: ContextSpec[];
  modelOptions?: ModelOptions;
};

type RoutingConfig = {
  core: ContextSpec[];
  routes: RouteDefinition[];
};

type RoutingSignals = {
  hasImages: boolean;
  hasAudio: boolean;
  audioEnabled: boolean;
  normalizedMessage: string;
  isFollowUp: boolean;
};

type ContextBlock = {
  label: string;
  path: string;
  content: string;
};

export type ResolvedContextBundle = {
  routeName: string;
  description: string;
  warning?: string;
  toolName?: ToolName;
  signalKey?: RuntimeSignalKey;
  responseMode?: "model" | "local_direct";
  rationale: string[];
  blocks: ContextBlock[];
  selectedSources: string[];
  contextCharCount: number;
  modelOptions?: ModelOptions;
};

const ROUTING_CONFIG_PATH = path.join("runtime", "context-routing.md");
const ROUTING_MARKER_START = "<!-- ROUTING_CONFIG_START -->";
const ROUTING_MARKER_END = "<!-- ROUTING_CONFIG_END -->";
const FOLLOW_UP_KEYWORDS = [
  "继续",
  "刚才",
  "上一轮",
  "上次",
  "再解释",
  "为什么",
  "那个判断",
  "还是这个场景",
  "如果是"
];

function normalizeText(value: string) {
  return value.trim().toLowerCase();
}

function buildContextLabel(spec: ContextSpec) {
  const suffix: string[] = [];

  if (spec.sections && spec.sections.length > 0) {
    suffix.push(`sections=${spec.sections.join("|")}`);
  }

  if (typeof spec.recentTurns === "number") {
    suffix.push(`recentTurns=${spec.recentTurns}`);
  }

  return suffix.length > 0 ? `${spec.path} (${suffix.join(", ")})` : spec.path;
}

function mergeSpecs(specs: ContextSpec[]) {
  const merged = new Map<string, ContextSpec>();

  for (const spec of specs) {
    const existing = merged.get(spec.path);

    if (!existing) {
      merged.set(spec.path, {
        path: spec.path,
        sections: spec.sections ? [...spec.sections] : undefined,
        recentTurns: spec.recentTurns
      });
      continue;
    }

    if (existing.sections || spec.sections) {
      existing.sections = Array.from(
        new Set([...(existing.sections || []), ...(spec.sections || [])])
      );
    }

    if (typeof spec.recentTurns === "number") {
      existing.recentTurns = Math.max(existing.recentTurns || 0, spec.recentTurns);
    }
  }

  return Array.from(merged.values());
}

function extractRoutingJson(markdown: string) {
  const start = markdown.indexOf(ROUTING_MARKER_START);
  const end = markdown.indexOf(ROUTING_MARKER_END);

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Missing routing config markers in runtime/context-routing.md.");
  }

  const betweenMarkers = markdown.slice(start + ROUTING_MARKER_START.length, end);
  const fenceMatch = /```json\s*([\s\S]*?)\s*```/i.exec(betweenMarkers);

  if (!fenceMatch) {
    throw new Error("Missing JSON code block in runtime/context-routing.md.");
  }

  return fenceMatch[1].trim();
}

async function readRoutingConfig(): Promise<RoutingConfig> {
  const markdown = await readMarkdown(ROUTING_CONFIG_PATH);
  return JSON.parse(extractRoutingJson(markdown)) as RoutingConfig;
}

function detectFollowUp(normalizedMessage: string) {
  return FOLLOW_UP_KEYWORDS.some((keyword) => normalizedMessage.includes(keyword));
}

function detectQuestionLike(normalizedMessage: string) {
  if (!normalizedMessage) {
    return false;
  }

  const explicitQuestionMarkers = [
    "?",
    "？",
    "什么是",
    "怎么",
    "如何",
    "为什么",
    "区别",
    "介绍",
    "在哪",
    "哪里",
    "天气",
    "几点",
    "时间"
  ];

  return explicitQuestionMarkers.some((marker) => normalizedMessage.includes(marker));
}

function matchesStartsWithAny(normalizedMessage: string, prefixes?: string[]) {
  if (!prefixes || prefixes.length === 0) {
    return true;
  }

  return prefixes.some((prefix) => normalizedMessage.startsWith(prefix.toLowerCase()));
}

function matchesStartsWithNone(normalizedMessage: string, prefixes?: string[]) {
  if (!prefixes || prefixes.length === 0) {
    return true;
  }

  return prefixes.every((prefix) => !normalizedMessage.startsWith(prefix.toLowerCase()));
}

function matchesKeywordsAny(normalizedMessage: string, keywords?: string[]) {
  if (!keywords || keywords.length === 0) {
    return true;
  }

  return keywords.some((keyword) => normalizedMessage.includes(keyword.toLowerCase()));
}

function matchesKeywordsAll(normalizedMessage: string, keywords?: string[]) {
  if (!keywords || keywords.length === 0) {
    return true;
  }

  return keywords.every((keyword) => normalizedMessage.includes(keyword.toLowerCase()));
}

function matchesKeywordsNone(normalizedMessage: string, keywords?: string[]) {
  if (!keywords || keywords.length === 0) {
    return true;
  }

  return keywords.every((keyword) => !normalizedMessage.includes(keyword.toLowerCase()));
}

function matchesRoute(route: RouteDefinition, signals: RoutingSignals) {
  if (route.match.default) {
    return true;
  }

  if (
    typeof route.match.hasImages === "boolean" &&
    route.match.hasImages !== signals.hasImages
  ) {
    return false;
  }

  if (
    typeof route.match.hasAudio === "boolean" &&
    route.match.hasAudio !== signals.hasAudio
  ) {
    return false;
  }

  if (
    typeof route.match.audioEnabled === "boolean" &&
    route.match.audioEnabled !== signals.audioEnabled
  ) {
    return false;
  }

  if (
    typeof route.match.followUp === "boolean" &&
    route.match.followUp !== signals.isFollowUp
  ) {
    return false;
  }

  if (
    typeof route.match.questionLike === "boolean" &&
    route.match.questionLike !== detectQuestionLike(signals.normalizedMessage)
  ) {
    return false;
  }

  if (!matchesStartsWithAny(signals.normalizedMessage, route.match.startsWithAny)) {
    return false;
  }

  if (!matchesStartsWithNone(signals.normalizedMessage, route.match.startsWithNone)) {
    return false;
  }

  if (!matchesKeywordsAny(signals.normalizedMessage, route.match.keywordsAny)) {
    return false;
  }

  if (!matchesKeywordsAll(signals.normalizedMessage, route.match.keywordsAll)) {
    return false;
  }

  if (!matchesKeywordsNone(signals.normalizedMessage, route.match.keywordsNone)) {
    return false;
  }

  return true;
}

function buildRationale(route: RouteDefinition, signals: RoutingSignals) {
  const reasons = [`命中路由：${route.description}`];

  if (route.toolName) {
    reasons.push(`本轮需要进入工具子链：${route.toolName}`);
  }

  if (route.responseMode === "local_direct") {
    reasons.push("该路由已收敛为本地直出路径，将优先依据本地信号或工具结果直接生成最终回复");
  }

  if (signals.hasImages) {
    reasons.push("检测到图片输入，因此需要按巡视画面相关链路披露上下文");
  }

  if (signals.hasAudio && !signals.audioEnabled) {
    reasons.push("检测到音频输入且当前音频能力未启用，因此转入音频未启用路由");
  }

  if (signals.isFollowUp) {
    reasons.push("文本包含连续追问信号，因此需要引入最近交互摘录");
  }

  if (!signals.hasImages && !signals.hasAudio && route.name === "greeting_status") {
    reasons.push("当前是轻量问候 / 状态试探文本，因此不披露完整巡视判断链路");
  }

  if (!signals.hasImages && !signals.hasAudio && route.name === "text_patrol") {
    reasons.push("当前是纯文本任务，但不属于轻量问候，因此按文本巡视判断处理");
  }

  return reasons;
}

async function loadContextBlock(spec: ContextSpec): Promise<ContextBlock> {
  let content: string;

  if (typeof spec.recentTurns === "number") {
    content = await readRecentInteractionsExcerpt(spec.path, spec.recentTurns);
  } else if (spec.sections && spec.sections.length > 0) {
    content = await readMarkdownSections(spec.path, spec.sections);
  } else {
    content = await readMarkdown(spec.path);
  }

  return {
    label: buildContextLabel(spec),
    path: spec.path,
    content
  };
}

export async function resolveContextBundle(payload: UploadPayload): Promise<ResolvedContextBundle> {
  const routingConfig = await readRoutingConfig();
  const signals: RoutingSignals = {
    hasImages: payload.imageDataUrls.length > 0,
    hasAudio: payload.audioNames.length > 0,
    audioEnabled: process.env.AUDIO_ENABLED === "true",
    normalizedMessage: normalizeText(payload.message),
    isFollowUp: detectFollowUp(normalizeText(payload.message))
  };

  const route = [...routingConfig.routes]
    .sort((left, right) => right.priority - left.priority)
    .find((candidate) => matchesRoute(candidate, signals));

  if (!route) {
    throw new Error("No matching route found in runtime/context-routing.md.");
  }

  const mergedSpecs = mergeSpecs([...routingConfig.core, ...route.include]);
  const blocks = await Promise.all(mergedSpecs.map(loadContextBlock));
  const selectedSources = blocks.map((block) => block.label);
  const contextCharCount = blocks.reduce((total, block) => total + block.content.length, 0);

  return {
    routeName: route.name,
    description: route.description,
    warning: route.warning,
    toolName: route.toolName,
    signalKey: route.signalKey,
    responseMode: route.responseMode || "model",
    rationale: buildRationale(route, signals),
    blocks,
    selectedSources,
    contextCharCount,
    modelOptions: route.modelOptions
  };
}
