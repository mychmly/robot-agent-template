import { promises as fs } from "fs";
import path from "path";
import { StructuredResponse, UiState } from "./types";

const ROOT = process.cwd();
const RECENT_TURN_SEPARATOR = "\n\n---\n\n";
const MAX_RECENT_TURNS = 5;
const DEFAULT_LONG_TERM_MEMORY = `# long-term-memory.md

## 长期偏好

- 偏好 1：

## 稳定观点

- 观点 1：

## 持续有效的事实

- 事实 1：

## 最近新增候选（待人工检查）

- 暂无
`;

type ParsedSection = {
  heading: string;
  lines: string[];
};

function resolvePath(...segments: string[]) {
  return path.join(ROOT, ...segments);
}

async function ensureFile(filePath: string, fallback = "") {
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, fallback, "utf8");
  }
}

function parseMarkdownSections(markdown: string) {
  const lines = markdown.split(/\r?\n/);
  const prelude: string[] = [];
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;

  for (const line of lines) {
    const headingMatch = /^(##|###)\s+(.+)$/.exec(line);

    if (headingMatch) {
      if (current) {
        sections.push(current);
      }

      current = {
        heading: headingMatch[2].trim(),
        lines: [line]
      };
      continue;
    }

    if (current) {
      current.lines.push(line);
    } else {
      prelude.push(line);
    }
  }

  if (current) {
    sections.push(current);
  }

  return {
    prelude: prelude.join("\n").trimEnd(),
    sections
  };
}

function rebuildMarkdownSections(parsed: {
  prelude: string;
  sections: ParsedSection[];
}) {
  const blocks: string[] = [];

  if (parsed.prelude) {
    blocks.push(parsed.prelude.trimEnd());
  }

  blocks.push(...parsed.sections.map((section) => section.lines.join("\n").trimEnd()));

  return `${blocks.join("\n\n").trim()}\n`;
}

function buildSectionExcerpt(markdown: string, requestedSections: string[]) {
  if (requestedSections.length === 0) {
    return markdown;
  }

  const { prelude, sections } = parseMarkdownSections(markdown);
  const normalizedRequested = requestedSections.map((section) => section.trim()).filter(Boolean);
  const matchedSections = sections.filter((section) =>
    normalizedRequested.some((requested) => section.heading.includes(requested))
  );

  if (matchedSections.length === 0) {
    return markdown;
  }

  const blocks: string[] = [];

  if (prelude) {
    blocks.push(prelude);
  }

  blocks.push(...matchedSections.map((section) => section.lines.join("\n").trimEnd()));

  return `${blocks.join("\n\n").trim()}\n`;
}

export async function readMarkdown(relativePath: string) {
  const fullPath = resolvePath(relativePath);
  await ensureFile(fullPath);
  return fs.readFile(fullPath, "utf8");
}

export async function readMarkdownSections(relativePath: string, requestedSections: string[]) {
  const markdown = await readMarkdown(relativePath);
  return buildSectionExcerpt(markdown, requestedSections);
}

export async function writeMarkdown(relativePath: string, content: string) {
  const fullPath = resolvePath(relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
}

export async function readSystemContext() {
  const [
    identity,
    soul,
    input,
    knowledge,
    boundaries,
    memoryPolicy,
    ownerProfile,
    longTermMemory,
    currentState,
    recentInteractions,
    outputSchema
  ] = await Promise.all([
    readMarkdown("identity.md"),
    readMarkdown("SOUL.md"),
    readMarkdown("input.md"),
    readMarkdown("knowledge-and-tools.md"),
    readMarkdown("boundaries.md"),
    readMarkdown(path.join("memory", "policy.md")),
    readMarkdown(path.join("memory", "owner-profile.md")),
    readMarkdown(path.join("memory", "long-term-memory.md")),
    readMarkdown(path.join("memory", "current-state.md")),
    readMarkdown(path.join("memory", "recent-interactions.md")),
    readMarkdown(path.join("output", "schema.md"))
  ]);

  return {
    identity,
    soul,
    input,
    knowledge,
    boundaries,
    memoryPolicy,
    ownerProfile,
    longTermMemory,
    currentState,
    recentInteractions,
    outputSchema
  };
}

export async function readUiState(): Promise<UiState> {
  const [ownerProfile, longTermMemory] = await Promise.all([
    readMarkdown(path.join("memory", "owner-profile.md")),
    readMarkdown(path.join("memory", "long-term-memory.md"))
  ]);

  return {
    ownerProfile,
    longTermMemory
  };
}

function normalizeValue(value: string) {
  return value.trim() || "未生成";
}

function normalizeInlineText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function getTimestampLabel() {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
}

function extractRecentTurns(previousContent: string) {
  const trimmed = previousContent.trim();

  if (!trimmed) {
    return [] as string[];
  }

  const marker = "## 交互记录";
  if (trimmed.includes(marker)) {
    const [, body = ""] = trimmed.split(marker);
    return body
      .trim()
      .split(RECENT_TURN_SEPARATOR)
      .map((block) => block.trim())
      .filter((block) =>
        Boolean(block) &&
        (block.startsWith("### 回合") || block.startsWith("### 历史迁移记录"))
      );
  }

  const legacy = trimmed.replace(/^# .*$/gm, "").trim();
  if (!legacy) {
    return [];
  }

  return [`### 历史迁移记录\n${legacy}`];
}

export async function readRecentInteractionsExcerpt(
  relativePath: string,
  maxTurns: number
) {
  const markdown = await readMarkdown(relativePath);
  const turns = extractRecentTurns(markdown).slice(0, Math.max(1, maxTurns));

  if (turns.length === 0) {
    return markdown;
  }

  return `# recent-interactions.md

## 交互记录（最近 ${turns.length} 轮摘录）

${turns.join(RECENT_TURN_SEPARATOR)}
`;
}

function shouldAppendToLongTerm(memoryUpdate: string) {
  const normalized = normalizeInlineText(memoryUpdate);

  if (!normalized) {
    return false;
  }

  const negativeSignals = [
    "无新增长期记忆",
    "未更新长期记忆",
    "不更新长期记忆",
    "无需写入长期记忆",
    "仅更新recent-interactions",
    "仅更新recent-interactions.md",
    "仅更新当前状态",
    "初始化测试交互",
    "音频当前未启用",
    "本轮",
    "当前",
    "测试",
    "未启用",
    "错误",
    "失败",
    "提示改用"
  ];

  return !negativeSignals.some((signal) => normalized.includes(signal));
}

function appendLongTermCandidate(previousContent: string, candidate: string) {
  const normalizedCandidate = normalizeInlineText(candidate);
  const existing = previousContent.trim() || DEFAULT_LONG_TERM_MEMORY.trim();
  const sectionTitle = "## 最近新增候选（待人工检查）";

  if (existing.includes(`- ${normalizedCandidate}`)) {
    return `${existing}\n`;
  }

  if (!existing.includes(sectionTitle)) {
    return `${existing}\n\n${sectionTitle}\n\n- ${normalizedCandidate}\n`;
  }

  if (existing.includes(`${sectionTitle}\n\n- 暂无`)) {
    return `${existing.replace(`${sectionTitle}\n\n- 暂无`, `${sectionTitle}\n\n- ${normalizedCandidate}`)}\n`;
  }

  return `${existing}\n- ${normalizedCandidate}\n`;
}

export function formatLatestResponseMarkdown(
  payload: StructuredResponse,
  inputSummary: string
) {
  return `# latest-response.md

## 最近一次中文解释性回复

- 回复：${normalizeValue(payload.reply)}

## 最近一次结构化输出结果

- \`intent\`：${normalizeValue(payload.intent)}
- \`decision\`：${normalizeValue(payload.decision)}
- \`action\`：${normalizeValue(payload.action)}
- \`reason\`：${normalizeValue(payload.reason)}
- \`memory_update\`：${normalizeValue(payload.memory_update)}

## 本轮输入来源摘要

- 输入来源：${normalizeValue(inputSummary)}

## 本轮记忆更新摘要

- 更新摘要：${normalizeValue(payload.memory_update)}
`;
}

export function formatCurrentStateMarkdown(payload: StructuredResponse) {
  return `# current-state.md

## 当前系统状态

- 当前状态：已完成一次巡视判断

## 最近一次巡视判断摘要

- 判断摘要：${normalizeValue(payload.decision)}

## 最近一次输出动作

- 动作：${normalizeValue(payload.action)}

## 下一步可能动作

- 下一步：等待下一次巡视触发，或由主人补充信息 / 确认提醒
`;
}

export function formatRecentInteractionsMarkdown(
  userInput: string,
  payload: StructuredResponse,
  previousContent: string
) {
  const currentTurn = `### 回合 ${getTimestampLabel()}
- 事件输入：${normalizeInlineText(normalizeValue(userInput))}
- 系统回复：${normalizeInlineText(normalizeValue(payload.reply))}
- 结构化决策摘要：${normalizeInlineText(normalizeValue(payload.decision))}
- 记忆更新摘要：${normalizeInlineText(normalizeValue(payload.memory_update))}`;

  const previousTurns = extractRecentTurns(previousContent);
  const turns = [currentTurn, ...previousTurns].slice(0, MAX_RECENT_TURNS);

  return `# recent-interactions.md

## 交互记录

${turns.join(RECENT_TURN_SEPARATOR)}
`;
}

export function formatLongTermMemoryMarkdown(
  previousContent: string,
  memoryUpdate: string
) {
  if (!shouldAppendToLongTerm(memoryUpdate)) {
    return `${(previousContent.trim() || DEFAULT_LONG_TERM_MEMORY.trim())}\n`;
  }

  return appendLongTermCandidate(previousContent, memoryUpdate);
}

export type MarkdownPersistenceOptions = {
  persistRecentInteractions?: boolean;
  persistLongTermMemory?: boolean;
  persistOwnerProfile?: boolean;
};

export type MarkdownUpdateResult = {
  recentInteractionsUpdated: boolean;
  longTermMemoryUpdated: boolean;
  ownerProfileUpdated: boolean;
};

function stripRememberPrefix(userInput: string) {
  return userInput
    .trim()
    .replace(/^(请记住|帮我记住|记住[:：]?|你要记住[:：]?)/, "")
    .replace(/^[：:\s]+/, "")
    .trim();
}

function classifyOwnerProfileSection(candidate: string) {
  const preferenceSignals = [
    "喜欢",
    "不喜欢",
    "偏好",
    "希望",
    "不希望",
    "更在意",
    "更喜欢",
    "不想",
    "讨厌"
  ];

  return preferenceSignals.some((signal) => candidate.includes(signal))
    ? "已知偏好"
    : "已知背景信息";
}

function appendBulletToSection(
  previousContent: string,
  sectionKeyword: string,
  bullet: string
) {
  const parsed = parseMarkdownSections(previousContent);
  const normalizedBullet = normalizeInlineText(bullet);
  let updated = false;

  for (const section of parsed.sections) {
    if (!section.heading.includes(sectionKeyword)) {
      continue;
    }

    const existingBullets = section.lines
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => normalizeInlineText(line.slice(2)));

    if (existingBullets.includes(normalizedBullet)) {
      return {
        content: `${previousContent.trimEnd()}\n`,
        updated: false
      };
    }

    while (section.lines.length > 0 && section.lines[section.lines.length - 1].trim() === "") {
      section.lines.pop();
    }

    section.lines.push("", `- ${bullet}`);
    updated = true;
    break;
  }

  if (!updated) {
    const heading = `## ${sectionKeyword}`;
    parsed.sections.push({
      heading: sectionKeyword,
      lines: [heading, "", `- ${bullet}`]
    });
    updated = true;
  }

  return {
    content: rebuildMarkdownSections(parsed),
    updated
  };
}

function formatOwnerProfileMarkdown(previousContent: string, userInput: string) {
  const candidate = stripRememberPrefix(userInput);

  if (!candidate) {
    return {
      content: `${previousContent.trimEnd()}\n`,
      updated: false
    };
  }

  const sectionKeyword = classifyOwnerProfileSection(candidate);
  return appendBulletToSection(previousContent, sectionKeyword, candidate);
}

export async function updateMarkdownState(
  userInput: string,
  payload: StructuredResponse,
  options: MarkdownPersistenceOptions = {}
): Promise<MarkdownUpdateResult> {
  const persistRecentInteractions = options.persistRecentInteractions ?? false;
  const persistLongTermMemory = options.persistLongTermMemory ?? false;
  const persistOwnerProfile = options.persistOwnerProfile ?? false;

  const writes: Array<Promise<void>> = [];
  let recentInteractionsUpdated = false;
  let longTermMemoryUpdated = false;
  let ownerProfileUpdated = false;

  if (persistRecentInteractions) {
    const previousRecent = await readMarkdown(path.join("memory", "recent-interactions.md"));
    writes.push(
      writeMarkdown(
        path.join("memory", "recent-interactions.md"),
        formatRecentInteractionsMarkdown(userInput, payload, previousRecent)
      )
    );
    recentInteractionsUpdated = true;
  }

  if (persistLongTermMemory) {
    const previousLongTerm = await readMarkdown(
      path.join("memory", "long-term-memory.md")
    );
    const nextLongTerm = formatLongTermMemoryMarkdown(previousLongTerm, payload.memory_update);

    if (nextLongTerm.trimEnd() !== previousLongTerm.trimEnd()) {
      writes.push(
        writeMarkdown(path.join("memory", "long-term-memory.md"), nextLongTerm)
      );
      longTermMemoryUpdated = true;
    }
  }

  if (persistOwnerProfile) {
    const previousOwnerProfile = await readMarkdown(path.join("memory", "owner-profile.md"));
    const nextOwnerProfile = formatOwnerProfileMarkdown(previousOwnerProfile, userInput);

    if (nextOwnerProfile.updated) {
      writes.push(
        writeMarkdown(path.join("memory", "owner-profile.md"), nextOwnerProfile.content)
      );
      ownerProfileUpdated = true;
    }
  }

  await Promise.all(writes);

  return {
    recentInteractionsUpdated,
    longTermMemoryUpdated,
    ownerProfileUpdated
  };
}
