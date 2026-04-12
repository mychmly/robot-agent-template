"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import {
  ChatResponsePayload,
  ExecutionInfo,
  StageEventMeta,
  StageName,
  StageStatus,
  StageStreamEvent,
  StructuredResponse,
  ToolExecutionResult,
  UiState
} from "../backend/types";

type AttachmentKind = "image" | "audio" | "other";
type MessageStatus = "ready" | "pending" | "error" | "cancelled";

type AttachmentMeta = {
  name: string;
  type: string;
  kind: AttachmentKind;
  previewUrl?: string;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  attachments?: AttachmentMeta[];
  structured?: StructuredResponse;
  execution?: ExecutionInfo;
  tool?: ToolExecutionResult;
  status?: MessageStatus;
  stageTrace?: StageTrace;
};

type ChatSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
};

type PersistedAttachment = {
  name: string;
  type: string;
  kind: AttachmentKind;
};

type PersistedMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  attachments?: PersistedAttachment[];
  structured?: StructuredResponse;
  execution?: ExecutionInfo;
  tool?: ToolExecutionResult;
  status?: "ready" | "cancelled" | "error";
  stageTrace?: PersistedStageTrace;
};

type StageTimelineEntry = {
  stage: StageName;
  status: StageStatus;
  label: string;
  ts: string;
  durationMs?: number;
  meta?: StageEventMeta;
};

type StageTraceOutcome =
  | {
      type: "completed";
      totalDurationMs: number;
    }
  | {
      type: "error";
      stage: StageName | "unknown";
      message: string;
    }
  | {
      type: "cancelled";
      lastSafeStage?: StageName;
      markdownCommitted: boolean;
    };

type StageTrace = {
  entries: StageTimelineEntry[];
  outcome?: StageTraceOutcome;
};

type PersistedStageTrace = {
  entries: StageTimelineEntry[];
  outcome?: StageTraceOutcome;
};

type PersistedSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: PersistedMessage[];
};

type Props = {
  initialState: UiState;
};

const SESSION_STORAGE_KEY = "robot-agent-student-ui-sessions-v1";
const ACTIVE_SESSION_STORAGE_KEY = "robot-agent-student-ui-active-session-v1";
const TITLE_SNIPPET_LENGTH = 18;
const BOOTSTRAP_SESSION_ID = "__bootstrap_session__";
const BOOTSTRAP_TIMESTAMP = "pending";

const BOOTSTRAP_SESSION: ChatSession = {
  id: BOOTSTRAP_SESSION_ID,
  title: "新会话 1",
  createdAt: BOOTSTRAP_TIMESTAMP,
  updatedAt: BOOTSTRAP_TIMESTAMP,
  messages: []
};

const STAGE_ORDER: StageName[] = [
  "accepted",
  "routing",
  "tool",
  "response",
  "commit",
  "state_refresh"
];

function stageOrderIndex(stage: StageName) {
  return STAGE_ORDER.indexOf(stage);
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sortSessions(sessions: ChatSession[]) {
  return [...sessions].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

function sanitizeInlineText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function truncateTitle(value: string) {
  const normalized = sanitizeInlineText(value);
  if (!normalized) {
    return "";
  }

  if (normalized.length <= TITLE_SNIPPET_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, TITLE_SNIPPET_LENGTH).trimEnd()}...`;
}

function detectAttachmentKind(type: string) {
  if (type.startsWith("image/")) {
    return "image";
  }

  if (type.startsWith("audio/")) {
    return "audio";
  }

  return "other";
}

function buildQueuedAttachments(files: File[]) {
  return files.map((file) => {
    const kind = detectAttachmentKind(file.type);
    return {
      name: file.name,
      type: file.type,
      kind,
      previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined
    } satisfies AttachmentMeta;
  });
}

function releaseAttachmentPreviews(attachments: AttachmentMeta[]) {
  attachments.forEach((attachment) => {
    if (attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  });
}

function serializeSessions(sessions: ChatSession[]): PersistedSession[] {
  return sessions.map((session) => ({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages
      .filter((message) => message.status !== "pending")
      .map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        structured: message.structured,
        execution: message.execution,
        tool: message.tool,
        stageTrace: message.stageTrace,
        status:
          message.status === "cancelled"
            ? "cancelled"
            : message.status === "error"
              ? "error"
              : "ready",
        attachments: message.attachments?.map((attachment) => ({
          name: attachment.name,
          type: attachment.type,
          kind: attachment.kind
        }))
      }))
  }));
}

function parseStageTrace(value: unknown): StageTrace | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.entries)) {
    return undefined;
  }

  const entries = candidate.entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [] as StageTimelineEntry[];
    }

    const stageCandidate = entry as Record<string, unknown>;
    if (
      typeof stageCandidate.stage !== "string" ||
      !STAGE_ORDER.includes(stageCandidate.stage as StageName) ||
      typeof stageCandidate.status !== "string" ||
      !["started", "completed", "skipped", "fallback"].includes(stageCandidate.status) ||
      typeof stageCandidate.label !== "string" ||
      typeof stageCandidate.ts !== "string"
    ) {
      return [] as StageTimelineEntry[];
    }

    return [
      {
        stage: stageCandidate.stage as StageName,
        status: stageCandidate.status as StageStatus,
        label: stageCandidate.label,
        ts: stageCandidate.ts,
        durationMs:
          typeof stageCandidate.durationMs === "number" ? stageCandidate.durationMs : undefined,
        meta:
          stageCandidate.meta && typeof stageCandidate.meta === "object"
            ? (stageCandidate.meta as StageEventMeta)
            : undefined
      } satisfies StageTimelineEntry
    ];
  });

  let outcome: StageTraceOutcome | undefined;
  if (candidate.outcome && typeof candidate.outcome === "object") {
    const outcomeCandidate = candidate.outcome as Record<string, unknown>;
    if (
      outcomeCandidate.type === "completed" &&
      typeof outcomeCandidate.totalDurationMs === "number"
    ) {
      outcome = {
        type: "completed",
        totalDurationMs: outcomeCandidate.totalDurationMs
      };
    } else if (
      outcomeCandidate.type === "error" &&
      typeof outcomeCandidate.stage === "string" &&
      typeof outcomeCandidate.message === "string"
    ) {
      outcome = {
        type: "error",
        stage: outcomeCandidate.stage as StageName | "unknown",
        message: outcomeCandidate.message
      };
    } else if (
      outcomeCandidate.type === "cancelled" &&
      typeof outcomeCandidate.markdownCommitted === "boolean"
    ) {
      outcome = {
        type: "cancelled",
        lastSafeStage:
          typeof outcomeCandidate.lastSafeStage === "string"
            ? (outcomeCandidate.lastSafeStage as StageName)
            : undefined,
        markdownCommitted: outcomeCandidate.markdownCommitted
      };
    }
  }

  return {
    entries: [...entries].sort((a, b) => stageOrderIndex(a.stage) - stageOrderIndex(b.stage)),
    outcome
  };
}

function parseAttachment(value: unknown): PersistedAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const kind = candidate.kind;

  if (
    typeof candidate.name !== "string" ||
    typeof candidate.type !== "string" ||
    (kind !== "image" && kind !== "audio" && kind !== "other")
  ) {
    return null;
  }

  return {
    name: candidate.name,
    type: candidate.type,
    kind
  };
}

function parseStructured(value: unknown): StructuredResponse | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.reply !== "string" ||
    typeof candidate.intent !== "string" ||
    typeof candidate.decision !== "string" ||
    typeof candidate.action !== "string" ||
    typeof candidate.reason !== "string" ||
    typeof candidate.memory_update !== "string"
  ) {
    return undefined;
  }

  return {
    reply: candidate.reply,
    intent: candidate.intent,
    decision: candidate.decision,
    action: candidate.action,
    reason: candidate.reason,
    memory_update: candidate.memory_update
  };
}

function parseExecution(value: unknown): ExecutionInfo | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.action_type !== "string" ||
    typeof candidate.execution_mode !== "string" ||
    typeof candidate.instruction !== "string" ||
    typeof candidate.requires_confirmation !== "boolean" ||
    typeof candidate.risk_level !== "string"
  ) {
    return undefined;
  }

  return {
    action_type: candidate.action_type as ExecutionInfo["action_type"],
    execution_mode: candidate.execution_mode as ExecutionInfo["execution_mode"],
    instruction: candidate.instruction,
    requires_confirmation: candidate.requires_confirmation,
    risk_level: candidate.risk_level as ExecutionInfo["risk_level"]
  };
}

function restoreSessions(raw: string | null): ChatSession[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    const sessions = parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [] as ChatSession[];
      }

      const candidate = entry as Record<string, unknown>;
      if (
        typeof candidate.id !== "string" ||
        typeof candidate.title !== "string" ||
        typeof candidate.createdAt !== "string" ||
        typeof candidate.updatedAt !== "string" ||
        !Array.isArray(candidate.messages)
      ) {
        return [] as ChatSession[];
      }

      const messages = candidate.messages.flatMap((messageEntry) => {
        if (!messageEntry || typeof messageEntry !== "object") {
          return [] as Message[];
        }

        const messageCandidate = messageEntry as Record<string, unknown>;
        if (
          typeof messageCandidate.id !== "string" ||
          (messageCandidate.role !== "user" && messageCandidate.role !== "assistant") ||
          typeof messageCandidate.text !== "string" ||
          typeof messageCandidate.createdAt !== "string"
        ) {
          return [] as Message[];
        }

        const attachments = Array.isArray(messageCandidate.attachments)
          ? messageCandidate.attachments
              .map(parseAttachment)
              .filter((value): value is PersistedAttachment => Boolean(value))
          : undefined;

        return [
          {
            id: messageCandidate.id,
            role: messageCandidate.role,
            text: messageCandidate.text,
            createdAt: messageCandidate.createdAt,
            attachments,
            structured: parseStructured(messageCandidate.structured),
            execution: parseExecution(messageCandidate.execution),
            tool:
              messageCandidate.tool && typeof messageCandidate.tool === "object"
                ? (messageCandidate.tool as ToolExecutionResult)
                : undefined,
            stageTrace: parseStageTrace(messageCandidate.stageTrace),
            status:
              messageCandidate.status === "cancelled"
                ? "cancelled"
                : messageCandidate.status === "error"
                  ? "error"
                  : "ready"
          } satisfies Message
        ];
      });

      return [
        {
          id: candidate.id,
          title: candidate.title,
          createdAt: candidate.createdAt,
          updatedAt: candidate.updatedAt,
          messages
        } satisfies ChatSession
      ];
    });

    return sortSessions(sessions);
  } catch {
    return [];
  }
}

function buildEmptySessionLabel(existingCount: number) {
  return `新会话 ${existingCount + 1}`;
}

function extractOrdinalFromTitle(title: string, fallback: number) {
  const match = title.match(/(\d+)$/);
  return match ? Number(match[1]) : fallback;
}

function resolveSessionTitle(
  text: string,
  attachments: AttachmentMeta[],
  fallbackOrdinal: number
) {
  const snippet = truncateTitle(text);
  if (snippet) {
    return snippet;
  }

  if (attachments.some((attachment) => attachment.kind === "image")) {
    return `图片巡视 ${fallbackOrdinal}`;
  }

  if (attachments.some((attachment) => attachment.kind === "audio")) {
    return `音频测试 ${fallbackOrdinal}`;
  }

  return `新会话 ${fallbackOrdinal}`;
}

function buildAttachmentOnlyMessage(attachments: AttachmentMeta[]) {
  const imageCount = attachments.filter((attachment) => attachment.kind === "image").length;
  const audioCount = attachments.filter((attachment) => attachment.kind === "audio").length;

  if (imageCount > 0 && audioCount > 0) {
    return "系统上传了图片与音频附件。";
  }

  if (imageCount > 0) {
    return imageCount === 1 ? "系统上传了一张巡视图片。" : `系统上传了 ${imageCount} 张巡视图片。`;
  }

  if (audioCount > 0) {
    return audioCount === 1 ? "系统上传了一个音频附件。" : `系统上传了 ${audioCount} 个音频附件。`;
  }

  return "系统上传了附件。";
}

function formatSidebarTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }

  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();

  return new Intl.DateTimeFormat("zh-CN", {
    month: sameDay ? undefined : "2-digit",
    day: sameDay ? undefined : "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function summarizeSession(session: ChatSession) {
  const latest = [...session.messages]
    .filter((message) => message.status !== "pending")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

  if (!latest) {
    return "当前还没有对话";
  }

  const text = truncateTitle(latest.text);
  if (text) {
    return text;
  }

  if (latest.attachments?.length) {
    return "包含附件输入";
  }

  return latest.role === "assistant" ? "Agent 已返回结果" : "已创建会话";
}

function formatDuration(durationMs?: number) {
  if (typeof durationMs !== "number" || Number.isNaN(durationMs)) {
    return "--";
  }

  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }

  return `${(durationMs / 1000).toFixed(2)}s`;
}

function applyStageStreamEvent(
  current: StageTrace | undefined,
  event: StageStreamEvent
): StageTrace {
  const base: StageTrace = current
    ? {
        entries: [...current.entries],
        outcome: current.outcome
      }
    : {
        entries: []
      };

  if (event.type === "stage") {
    const nextEntries = [...base.entries];
    const existingIndex = nextEntries.findIndex((entry) => entry.stage === event.stage);
    const nextEntry: StageTimelineEntry = {
      stage: event.stage,
      status: event.status,
      label: event.label,
      ts: event.ts,
      durationMs: event.durationMs,
      meta: event.meta
    };

    if (existingIndex >= 0) {
      nextEntries[existingIndex] = nextEntry;
    } else {
      nextEntries.push(nextEntry);
    }

    return {
      ...base,
      entries: nextEntries.sort((a, b) => stageOrderIndex(a.stage) - stageOrderIndex(b.stage))
    };
  }

  if (event.type === "completed") {
    return {
      ...base,
      outcome: {
        type: "completed",
        totalDurationMs: event.totalDurationMs
      }
    };
  }

  if (event.type === "error") {
    return {
      ...base,
      outcome: {
        type: "error",
        stage: event.stage,
        message: event.message
      }
    };
  }

  return {
    ...base,
    outcome: {
      type: "cancelled",
      lastSafeStage: event.lastSafeStage,
      markdownCommitted: event.markdownCommitted
    }
  };
}

function getSlowestStage(entries: StageTimelineEntry[]) {
  const completedEntries = entries.filter((entry) => typeof entry.durationMs === "number");
  if (completedEntries.length === 0) {
    return null;
  }

  return [...completedEntries].sort(
    (a, b) => (b.durationMs || 0) - (a.durationMs || 0)
  )[0];
}

function renderMetaValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value, null, 2);
}

function StageTimeline({ stageTrace }: { stageTrace: StageTrace }) {
  const slowestStage = getSlowestStage(stageTrace.entries);

  return (
    <section className="stageTrace">
      <div className="stageTraceHead">
        <strong>阶段流（默认常驻）</strong>
        <span>阶段耗时（server-side）</span>
      </div>

      <div className="stageTraceList">
        {stageTrace.entries.map((entry) => (
          <div className={`stageRow ${entry.status}`} key={entry.stage}>
            <div className="stageRowMain">
              <span className="stageBadge">{entry.stage}</span>
              <span className="stageLabel">{entry.label}</span>
            </div>
            <span className="stageDuration">{formatDuration(entry.durationMs)}</span>
          </div>
        ))}
      </div>

      {stageTrace.outcome ? (
        <div className="stageMetrics">
          {"totalDurationMs" in stageTrace.outcome ? (
            <span>total：{formatDuration(stageTrace.outcome.totalDurationMs)}</span>
          ) : null}
          {slowestStage ? (
            <span>
              最慢阶段：{slowestStage.stage}（{formatDuration(slowestStage.durationMs)}）
            </span>
          ) : null}
          {stageTrace.outcome.type === "error" ? (
            <span>错误阶段：{stageTrace.outcome.stage}</span>
          ) : null}
          {stageTrace.outcome.type === "cancelled" ? (
            <span>
              取消前最后安全阶段：{stageTrace.outcome.lastSafeStage || "unknown"} / 写回：
              {stageTrace.outcome.markdownCommitted ? "已进入 commit" : "未写回"}
            </span>
          ) : null}
        </div>
      ) : null}

      <details className="stageDetails">
        <summary>查看工程细节</summary>
        <div className="stageDetailGrid">
          {stageTrace.entries.map((entry) => (
            <div className="stageDetailCard" key={`${entry.stage}-detail`}>
              <div className="stageDetailHead">
                <strong>{entry.stage}</strong>
                <span>{entry.status}</span>
              </div>
              {entry.meta && Object.keys(entry.meta).length > 0 ? (
                <div className="stageDetailMeta">
                  {Object.entries(entry.meta).map(([key, value]) => (
                    <div className="stageDetailItem" key={`${entry.stage}-${key}`}>
                      <div className="stageDetailKey">{key}</div>
                      <pre>{renderMetaValue(value)}</pre>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="stageDetailEmpty">当前阶段没有额外工程细节。</div>
              )}
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}

function AttachmentPreview({ attachment }: { attachment: AttachmentMeta }) {
  return (
    <div className={`attachmentCard ${attachment.kind}`}>
      {attachment.kind === "image" && attachment.previewUrl ? (
        <img alt={attachment.name} src={attachment.previewUrl} />
      ) : (
        <div className="attachmentFallback">{attachment.kind === "image" ? "图片附件" : attachment.kind === "audio" ? "音频附件" : "附件"}</div>
      )}
      <div className="attachmentMeta">
        <div>{attachment.name}</div>
        <div>{attachment.type || "未知文件类型"}</div>
      </div>
    </div>
  );
}

function StructuredDetails({ structured }: { structured: StructuredResponse }) {
  return (
    <details className="structuredDetails">
      <summary>查看决策详情</summary>
      <div className="structuredGrid">
        {Object.entries(structured).map(([key, value]) => (
          <div className="structuredCard" key={key}>
            <div className="structuredKey">{key}</div>
            <pre>{value}</pre>
          </div>
        ))}
      </div>
    </details>
  );
}

function ExecutionDetails({
  execution,
  title = "Execution Info"
}: {
  execution: ExecutionInfo;
  title?: string;
}) {
  const rows: Array<[string, string]> = [
    ["动作类型", execution.action_type],
    ["执行模式", execution.execution_mode],
    ["动作说明", execution.instruction],
    ["是否需确认", execution.requires_confirmation ? "是" : "否"],
    ["风险等级", execution.risk_level]
  ];

  return (
    <div className="toolBlock">
      <div className="toolHead">
        <strong>{title}</strong>
        <span>运行态执行接口</span>
      </div>
      <div className="toolGrid">
        {rows.map(([key, value]) => (
          <div className="toolCard" key={`${title}-${key}`}>
            <div className="toolKey">{key}</div>
            <div className="toolValue">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolDetails({ tool }: { tool: ToolExecutionResult }) {
  return (
    <div className="toolBlock">
      <div className="toolHead">
        <strong>工具调用</strong>
        <span>{tool.status === "success" ? "已调用" : "调用失败"}</span>
      </div>
      <div className="toolGrid">
        <div className="toolCard">
          <div className="toolKey">tool_used</div>
          <div className="toolValue">{tool.toolName}</div>
        </div>
        <div className="toolCard">
          <div className="toolKey">tool_status</div>
          <div className="toolValue">{tool.status}</div>
        </div>
        <div className="toolCard">
          <div className="toolKey">tool_summary</div>
          <div className="toolValue">{tool.summary}</div>
        </div>
        <div className="toolCard">
          <div className="toolKey">tool_source_count</div>
          <div className="toolValue">{tool.sources?.length ?? 0}</div>
        </div>
      </div>

      {tool.sources && tool.sources.length > 0 ? (
        <div className="toolSources">
          <div className="toolSourcesTitle">来源链接</div>
          <ul>
            {tool.sources.map((source) => (
              <li key={source.url}>
                <a href={source.url} rel="noreferrer" target="_blank">
                  <strong>{source.title}</strong>
                  <span>{source.url}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function getLatestRuntimeMessage(session: ChatSession | null) {
  if (!session) {
    return null;
  }

  return [...session.messages].reverse().find((entry) => entry.role === "assistant") || null;
}

function getLatestExecutionMessage(session: ChatSession | null) {
  if (!session) {
    return null;
  }

  return (
    [...session.messages]
      .reverse()
      .find((entry) => entry.role === "assistant" && entry.execution) || null
  );
}

function formatMessageStatus(status?: MessageStatus) {
  switch (status) {
    case "pending":
      return "运行中";
    case "error":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return "已完成";
  }
}

export function RobotAgentClient({ initialState }: Props) {
  const [sessions, setSessions] = useState<ChatSession[]>([BOOTSTRAP_SESSION]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(BOOTSTRAP_SESSION_ID);
  const [message, setMessage] = useState("");
  const [queuedFiles, setQueuedFiles] = useState<File[]>([]);
  const [queuedAttachments, setQueuedAttachments] = useState<AttachmentMeta[]>([]);
  const [state, setState] = useState<UiState>(initialState);
  const [statusNotice, setStatusNotice] = useState(
    "左侧用于组织前端会话，右侧已分为 Persistent Memory、当前会话 Runtime Snapshot 与 Execution Info。"
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [hasHydrated, setHasHydrated] = useState(false);
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const activeRequestRef = useRef<{
    controller: AbortController;
    sessionId: string;
    pendingMessageId: string;
    taskId: string;
  } | null>(null);

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const activeMessageCount = activeSession?.messages.length ?? 0;
  const activeRuntimeMessage = getLatestRuntimeMessage(activeSession);
  const activeExecutionMessage = getLatestExecutionMessage(activeSession);

  useEffect(() => {
    const restoredSessions = restoreSessions(window.sessionStorage.getItem(SESSION_STORAGE_KEY));
    const restoredActiveId = window.sessionStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
    if (restoredSessions.length > 0) {
      const nextActiveId = restoredSessions.some((session) => session.id === restoredActiveId)
        ? restoredActiveId
        : restoredSessions[0]?.id ?? null;

      setSessions(restoredSessions);
      setActiveSessionId(nextActiveId);
      setStatusNotice("已恢复上次刷新前的前端会话记录，可继续课堂演示。右侧继续区分持久记忆、当前会话运行态与执行信息。");
      setHasHydrated(true);
      return;
    }

    const timestamp = new Date().toISOString();
    const defaultSession: ChatSession = {
      id: createId("session"),
      title: "新会话 1",
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: []
    };

    setSessions([defaultSession]);
    setActiveSessionId(defaultSession.id);
    setStatusNotice("已为你准备一个默认新会话，可直接开始输入。");
    setHasHydrated(true);
  }, []);

  useEffect(() => {
    if (!hasHydrated) {
      return;
    }

    if (sessions.length === 0) {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
      window.sessionStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
      return;
    }

    window.sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify(serializeSessions(sessions))
    );

    if (activeSessionId) {
      window.sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, activeSessionId);
    }
  }, [activeSessionId, hasHydrated, sessions]);

  useEffect(() => {
    if (!hasHydrated) {
      return;
    }

    if (!activeSessionId && sessions.length > 0) {
      setActiveSessionId(sessions[0].id);
    }
  }, [activeSessionId, hasHydrated, sessions]);

  useEffect(() => {
    if (!activeSessionId) {
      return;
    }

    const element = chatLogRef.current;
    if (!element) {
      return;
    }

    element.scrollTo({
      top: element.scrollHeight,
      behavior: activeMessageCount > 1 ? "smooth" : "auto"
    });
  }, [activeMessageCount, activeSessionId]);

  function replaceQueuedFiles(nextFiles: File[]) {
    releaseAttachmentPreviews(queuedAttachments);
    setQueuedFiles(nextFiles);
    setQueuedAttachments(buildQueuedAttachments(nextFiles));
  }

  function clearComposer(options?: { releaseQueuedPreviews?: boolean }) {
    if (options?.releaseQueuedPreviews) {
      releaseAttachmentPreviews(queuedAttachments);
    }

    setMessage("");
    setQueuedFiles([]);
    setQueuedAttachments([]);
  }

  function updateSessions(mutator: (current: ChatSession[]) => ChatSession[]) {
    setSessions((current) => sortSessions(mutator(current)));
  }

  function patchMessage(
    sessionId: string,
    messageId: string,
    mutator: (message: Message) => Message,
    nextUpdatedAt?: string
  ) {
    updateSessions((current) =>
      current.map((session) => {
        if (session.id !== sessionId) {
          return session;
        }

        return {
          ...session,
          updatedAt: nextUpdatedAt || session.updatedAt,
          messages: session.messages.map((entry) =>
            entry.id === messageId ? mutator(entry) : entry
          )
        };
      })
    );
  }

  function handleStageStreamEvent(sessionId: string, pendingMessageId: string, event: StageStreamEvent) {
    if (event.type === "stage") {
      patchMessage(sessionId, pendingMessageId, (message) => ({
        ...message,
        stageTrace: applyStageStreamEvent(message.stageTrace, event)
      }));
      setStatusNotice(event.label);
      return;
    }

    if (event.type === "completed") {
      const updatedAt = new Date().toISOString();
      const assistantMessage: Message = {
        id: createId("message"),
        role: "assistant",
        text: event.payload.reply || "系统未返回有效回复。",
        structured: event.payload.structured,
        execution: event.payload.execution,
        tool: event.payload.tool,
        stageTrace: applyStageStreamEvent(undefined, event),
        createdAt: updatedAt,
        status: "ready"
      };

      patchMessage(sessionId, pendingMessageId, (message) => ({
        ...assistantMessage,
        stageTrace: applyStageStreamEvent(message.stageTrace, event)
      }), updatedAt);

      if (event.payload.state) {
        setState(event.payload.state);
      }
      setStatusNotice(
        event.payload.warning ||
          (event.payload.state
            ? "本轮判断已完成，持久记忆已刷新。"
            : "本轮判断已完成。本轮未写入持久记忆。")
      );
      setIsSubmitting(false);
      setIsCancelling(false);
      activeRequestRef.current = null;
      return;
    }

    if (event.type === "error") {
      const updatedAt = new Date().toISOString();
      const errorMessage: Message = {
        id: createId("message"),
        role: "assistant",
        text: `本轮请求失败：${event.message}`,
        createdAt: updatedAt,
        status: "error"
      };

      patchMessage(sessionId, pendingMessageId, (message) => ({
        ...errorMessage,
        stageTrace: applyStageStreamEvent(message.stageTrace, event)
      }), updatedAt);
      setStatusNotice("系统未完成本轮判断，请查看当前会话中的错误卡片后再继续。");
      setIsSubmitting(false);
      setIsCancelling(false);
      activeRequestRef.current = null;
      return;
    }

    const cancelledText = event.markdownCommitted
      ? "本轮任务已取消，但系统已进入持久记忆写回临界区，请以右侧 Persistent Memory 为准。"
      : "本轮任务已手动停止。当前未写回本轮持久记忆结果，你可以重新发起新的请求。";

    const updatedAt = new Date().toISOString();
    const cancelledMessage: Message = {
      id: createId("message"),
      role: "assistant",
      text: cancelledText,
      createdAt: updatedAt,
      status: "cancelled"
    };

    patchMessage(sessionId, pendingMessageId, (message) => ({
      ...cancelledMessage,
      stageTrace: applyStageStreamEvent(message.stageTrace, event)
    }), updatedAt);
    setStatusNotice(
      event.markdownCommitted
        ? "任务已停止，但当前请求已经进入持久记忆写回临界区。"
        : "已停止当前任务。当前未写回本轮持久记忆结果。"
    );
    setIsSubmitting(false);
    setIsCancelling(false);
    activeRequestRef.current = null;
  }

  function handleCreateSession() {
    if (isSubmitting || !hasHydrated) {
      return;
    }

    const timestamp = new Date().toISOString();
    const nextSession: ChatSession = {
      id: createId("session"),
      title: buildEmptySessionLabel(sessions.length),
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: []
    };

    clearComposer({ releaseQueuedPreviews: true });
    updateSessions((current) => [nextSession, ...current]);
    setActiveSessionId(nextSession.id);
    setStatusNotice("已创建新会话，可开始新的课堂演示路径。");
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    replaceQueuedFiles(Array.from(event.target.files || []));
  }

  function handleStopCurrentTask() {
    const activeRequest = activeRequestRef.current;

    if (!activeRequest || isCancelling) {
      return;
    }

    const cancelPayload = JSON.stringify({
      taskId: activeRequest.taskId
    });

    if (navigator.sendBeacon) {
      const blob = new Blob([cancelPayload], {
        type: "application/json"
      });
      navigator.sendBeacon("/api/chat/cancel", blob);
    } else {
      void fetch("/api/chat/cancel", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: cancelPayload,
        keepalive: true
      }).catch(() => null);
    }

    setIsCancelling(true);
    setStatusNotice("正在停止当前任务，请等待阶段流返回最终取消状态...");
  }

  async function consumeStageStream(
    response: Response,
    sessionId: string,
    pendingMessageId: string
  ) {
    if (!response.body) {
      throw new Error("阶段流响应缺少可读流。");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminalEventSeen = false;

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const normalized = line.trim();
        if (!normalized) {
          continue;
        }

        const event = JSON.parse(normalized) as StageStreamEvent;
        handleStageStreamEvent(sessionId, pendingMessageId, event);
        if (event.type !== "stage") {
          terminalEventSeen = true;
        }
      }
    }

    const tail = buffer.trim();
    if (tail) {
      const event = JSON.parse(tail) as StageStreamEvent;
      handleStageStreamEvent(sessionId, pendingMessageId, event);
      if (event.type !== "stage") {
        terminalEventSeen = true;
      }
    }

    return terminalEventSeen;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!activeSession) {
      setStatusNotice("请先点击 New Session 创建会话，再开始输入系统事件或上传附件。");
      return;
    }

    if (!message.trim() && queuedFiles.length === 0) {
      setStatusNotice("请至少输入一条系统事件说明，或上传一张巡视图片 / 音频附件。");
      return;
    }

    setIsSubmitting(true);
    setIsCancelling(false);
    setStatusNotice("Agent 正在思考并读取 Markdown 上下文...");

    const submittedText = message.trim();
    const submittedFiles = [...queuedFiles];
    const submittedAttachments = queuedAttachments.map((attachment) => ({ ...attachment }));
    const userText = submittedText || buildAttachmentOnlyMessage(submittedAttachments);
    const timestamp = new Date().toISOString();
    const pendingId = createId("message");
    const taskId = createId("task");
    const ordinal = extractOrdinalFromTitle(activeSession.title, sessions.length || 1);

    const userMessage: Message = {
      id: createId("message"),
      role: "user",
      text: userText,
      attachments: submittedAttachments,
      createdAt: timestamp,
      status: "ready"
    };

    const pendingMessage: Message = {
      id: pendingId,
      role: "assistant",
      text: "",
      createdAt: timestamp,
      status: "pending",
      stageTrace: {
        entries: []
      }
    };

    const controller = new AbortController();

    clearComposer();

    updateSessions((current) =>
      current.map((session) => {
        if (session.id !== activeSession.id) {
          return session;
        }

        const nextTitle =
          session.messages.length === 0
            ? resolveSessionTitle(submittedText, submittedAttachments, ordinal)
            : session.title;

        return {
          ...session,
          title: nextTitle,
          updatedAt: timestamp,
          messages: [...session.messages, userMessage, pendingMessage]
        };
      })
    );

    activeRequestRef.current = {
      controller,
      sessionId: activeSession.id,
      pendingMessageId: pendingId,
      taskId
    };

    try {
      const formData = new FormData();
      formData.append("taskId", taskId);
      formData.append("message", submittedText);
      submittedFiles.forEach((file) => formData.append("files", file));

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          Accept: "application/x-ndjson",
          "X-Stage-Stream": "1"
        },
        body: formData,
        signal: controller.signal
      });

      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("application/x-ndjson")) {
        const terminalEventSeen = await consumeStageStream(response, activeSession.id, pendingId);
        if (!terminalEventSeen) {
          throw new Error("阶段流在未返回终态事件时提前结束。");
        }
        return;
      }

      const payload = (await response.json()) as ChatResponsePayload;

      if (!response.ok || !payload.ok || !payload.reply || !payload.structured) {
        throw new Error(payload.error || "系统未返回有效结果。");
      }

      const assistantMessage: Message = {
        id: createId("message"),
        role: "assistant",
        text: payload.reply,
        structured: payload.structured,
        execution: payload.execution,
        tool: payload.tool,
        createdAt: new Date().toISOString(),
        status: "ready"
      };

      updateSessions((current) =>
        current.map((session) => {
          if (session.id !== activeSession.id) {
            return session;
          }

          return {
            ...session,
            updatedAt: assistantMessage.createdAt,
            messages: session.messages.map((entry) =>
              entry.id === pendingId ? assistantMessage : entry
            )
          };
        })
      );

      if (payload.state) {
        setState(payload.state);
      }
      setStatusNotice(
        payload.warning ||
          (payload.state ? "本轮判断已完成，持久记忆已刷新。" : "本轮判断已完成。本轮未写入持久记忆。")
      );
    } catch (submitError) {
      if (
        submitError instanceof Error &&
        submitError.name === "AbortError"
      ) {
        if (isCancelling) {
          return;
        }
        return;
      }

      const nextError =
        submitError instanceof Error ? submitError.message : "请求失败，请稍后重试。";

      const errorMessage: Message = {
        id: createId("message"),
        role: "assistant",
        text: `本轮请求失败：${nextError}`,
        createdAt: new Date().toISOString(),
        status: "error"
      };

      updateSessions((current) =>
        current.map((session) => {
          if (session.id !== activeSession.id) {
            return session;
          }

          return {
            ...session,
            messages: session.messages.map((entry) =>
              entry.id === pendingId ? errorMessage : entry
            )
          };
        })
      );

      setStatusNotice("系统未完成本轮判断，请查看当前会话中的错误卡片后再继续。"
      );
    } finally {
      if (activeRequestRef.current?.pendingMessageId === pendingId) {
        activeRequestRef.current = null;
      }
      setIsSubmitting(false);
      setIsCancelling(false);
    }
  }

  return (
    <main className="shell">
      <div className="frame">
        <section className="hero">
          <div className="heroEyebrow">Student Starter · Frontend Session Layer</div>
          <h1>robot-agent starter runtime</h1>
          <p>
            这是公开分发版的网页交互界面。左侧负责组织前端会话，中间负责展示聊天历史与附件输入，
            右侧区分当前模板的 Persistent Memory、当前会话 Runtime Snapshot，以及最近一次可展示的 Execution Info。
          </p>
          <div className="meta">
            <span className="chip">系统事件输入</span>
            <span className="chip">巡视图片输入</span>
            <span className="chip">音频接口预留</span>
            <span className="chip">持久记忆收敛</span>
          </div>
        </section>

        <div className="workspaceGrid">
          <aside className="panel sessionPanel">
            <div className="panelHead compact">
              <div>
                <div className="sectionEyebrow">前端会话层</div>
                <h2>Session List</h2>
              </div>
              <button
                className="button ghost"
                disabled={isSubmitting || isCancelling || !hasHydrated}
                onClick={handleCreateSession}
                type="button"
              >
                New Session
              </button>
            </div>
            <p className="panelDescription">
              左侧只管理前端聊天会话，不对应独立后端 Markdown 快照。
            </p>

            <div className="sessionList">
              {sessions.length === 0 ? (
                <div className="emptyCard compact">
                  <strong>当前暂无会话</strong>
                  <span>点击 New Session 开始一次新的测试或讨论。</span>
                </div>
              ) : (
                sessions.map((session) => {
                  const isActive = session.id === activeSessionId;
                  return (
                    <button
                      className={`sessionItem ${isActive ? "active" : ""}`}
                      disabled={isSubmitting || isCancelling}
                      key={session.id}
                      onClick={() => setActiveSessionId(session.id)}
                      type="button"
                    >
                      <div className="sessionItemTop">
                        <strong>{session.title}</strong>
                        <span>{formatSidebarTime(session.updatedAt)}</span>
                      </div>
                      <div className="sessionItemPreview">{summarizeSession(session)}</div>
                      <div className="sessionItemMeta">{session.messages.length} 条消息</div>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <section className="panel chatPanel">
            <div className="panelHead">
              <div>
                <div className="sectionEyebrow">聊天窗口</div>
                <h2>{activeSession ? activeSession.title : "Chat Window"}</h2>
              </div>
              <div className="panelMetaText">
                {activeSession ? `${activeSession.messages.length} 条消息` : "请先创建会话"}
              </div>
            </div>

            <div className="chatLog" ref={chatLogRef}>
              {!activeSession ? (
                <div className="emptyState">
                  <strong>正在准备默认会话</strong>
                  <p>系统正在恢复或创建前端会话，请稍候后直接开始输入。</p>
                </div>
              ) : activeSession.messages.length === 0 ? (
                <div className="emptyState">
                  <strong>当前还没有对话</strong>
                  <p>请直接输入系统事件说明，或上传巡视图片 / 音频附件。</p>
                </div>
              ) : (
                activeSession.messages.map((entry) => (
                  <div className={`messageRow ${entry.role}`} key={entry.id}>
                    <article
                      className={`bubble ${entry.role} ${entry.status === "pending" ? "pending" : ""} ${entry.status === "error" ? "errorBubble" : ""} ${entry.status === "cancelled" ? "cancelled" : ""}`}
                    >
                      <div className="bubbleHeader">
                        <strong>
                          {entry.role === "user"
                            ? "巡视输入 / 系统事件"
                            : entry.status === "pending"
                              ? "阶段流进行中"
                            : entry.status === "error"
                              ? "系统错误"
                              : entry.status === "cancelled"
                                ? "任务已取消"
                              : "Agent 输出"}
                        </strong>
                        <span>{formatSidebarTime(entry.createdAt)}</span>
                      </div>

                      {entry.stageTrace ? <StageTimeline stageTrace={entry.stageTrace} /> : null}

                      {entry.text ? <div className="bubbleText">{entry.text}</div> : null}

                      {entry.attachments && entry.attachments.length > 0 ? (
                        <div className="attachments">
                          {entry.attachments.map((attachment) => (
                            <AttachmentPreview attachment={attachment} key={`${entry.id}-${attachment.name}`} />
                          ))}
                        </div>
                      ) : null}

                      {entry.tool ? <ToolDetails tool={entry.tool} /> : null}

                      {entry.structured ? <StructuredDetails structured={entry.structured} /> : null}
                    </article>
                  </div>
                ))
              )}
            </div>

            <form className="composer" onSubmit={handleSubmit}>
              <div className="composerHead">
                <div>
                  <strong>输入区（Composer）</strong>
                  <span>用于发送系统事件说明、巡视图片与音频测试附件。</span>
                </div>
              </div>

              <textarea
                className="textarea"
                disabled={!activeSession || isSubmitting || isCancelling}
                placeholder="请输入系统事件，例如：系统事件：机器人刚完成一次客厅巡视，请判断是否需要主动提醒主人。"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />

              <div className="composerToolbar">
                <label className={`fileLabel ${!activeSession ? "disabled" : ""}`}>
                  <input
                    className="fileInput"
                    disabled={!activeSession || isSubmitting || isCancelling || !hasHydrated}
                    type="file"
                    accept="image/*,audio/*"
                    multiple
                    onChange={handleFileChange}
                  />
                  上传图片或音频
                </label>

                {isSubmitting ? (
                  <button
                    className="button danger"
                    disabled={!activeSession || !hasHydrated || isCancelling}
                    onClick={handleStopCurrentTask}
                    type="button"
                  >
                    {isCancelling ? "停止请求中..." : "停止当前任务"}
                  </button>
                ) : (
                  <button
                    className="button"
                    disabled={!activeSession || isSubmitting || isCancelling || !hasHydrated}
                    type="submit"
                  >
                    发送到 Agent
                  </button>
                )}
              </div>

              {queuedAttachments.length > 0 ? (
                <div className="attachmentQueue">
                  {queuedAttachments.map((attachment) => (
                    <AttachmentPreview attachment={attachment} key={`queued-${attachment.name}`} />
                  ))}
                </div>
              ) : null}

              <div className="inlineNote">
                {activeSession
                  ? statusNotice
                  : "系统正在准备默认会话。右侧将继续区分 Persistent Memory、当前会话 Runtime Snapshot 与 Execution Info。"}
              </div>
            </form>
          </section>

          <aside className="panel memoryPanel">
            <div className="panelHead compact">
              <div>
                <div className="sectionEyebrow">系统状态层</div>
                <h2>Memory Summary</h2>
              </div>
            </div>

            <p className="memoryDisclaimer">
              上半部分是当前模板的持久记忆资产，只在真正需要时写回 Markdown；下半部分是当前激活会话的运行态快照，不再持久化为 Markdown 文件。
            </p>

            <div className="memoryGrid">
              <div className="memoryCard">
                <h3>owner-profile.md</h3>
                <pre>{state.ownerProfile}</pre>
              </div>
              <div className="memoryCard">
                <h3>long-term-memory.md</h3>
                <pre>{state.longTermMemory}</pre>
              </div>
              <div className="memoryCard">
                <h3>Runtime Snapshot</h3>
                {activeRuntimeMessage ? (
                  <>
                    <p className="memoryDisclaimer">
                      当前会话最新运行态：{formatMessageStatus(activeRuntimeMessage.status)} ·{" "}
                      {new Date(activeRuntimeMessage.createdAt).toLocaleString("zh-CN", {
                        hour12: false
                      })}
                    </p>
                    <pre>{activeRuntimeMessage.text}</pre>
                    {activeRuntimeMessage.structured ? (
                      <StructuredDetails structured={activeRuntimeMessage.structured} />
                    ) : null}
                    {activeRuntimeMessage.tool ? (
                      <ToolDetails tool={activeRuntimeMessage.tool} />
                    ) : null}
                  </>
                ) : (
                  <pre>当前激活会话还没有产生运行结果。发送一次巡视请求后，这里会显示最新运行态快照。</pre>
                )}
              </div>
              <div className="memoryCard">
                <h3>Execution Info</h3>
                {activeExecutionMessage?.execution ? (
                  <>
                    <p className="memoryDisclaimer">
                      当前会话最近一次可展示的执行接口：{formatMessageStatus(activeExecutionMessage.status)} ·{" "}
                      {new Date(activeExecutionMessage.createdAt).toLocaleString("zh-CN", {
                        hour12: false
                      })}
                    </p>
                    <ExecutionDetails execution={activeExecutionMessage.execution} />
                  </>
                ) : (
                  <pre>当前会话还没有可展示的执行信息。完成一次判断后，这里会显示最近一次动作接口结果。</pre>
                )}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
