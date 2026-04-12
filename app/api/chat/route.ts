import { resolveContextBundle } from "../../backend/context-routing";
import { buildExecutionInfo } from "../../backend/execution";
import { readUiState, updateMarkdownState } from "../../backend/markdown";
import { buildLocalDirectResult } from "../../backend/local-direct";
import { requestModel } from "../../backend/model";
import { initializeRuntimeSignals } from "../../backend/runtime-signals";
import { executeToolForRoute } from "../../backend/tools";
import {
  beginTaskCommit,
  clearTask,
  isTaskCancelled,
  markTaskCompleted,
  registerTask,
  requestTaskCancellation,
  waitForCancellationWindow
} from "../../backend/task-registry";
import {
  ChatResponsePayload,
  StageName,
  StageStatus,
  StageStreamCancelledEvent,
  StageStreamCompletedEvent,
  StageStreamErrorEvent,
  StageStreamEvent,
  StageStreamStageEvent,
  StructuredResponse,
  ToolExecutionResult
} from "../../backend/types";

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];
const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".aiff", ".aac", ".ogg", ".flac"];
const STAGE_STREAM_HEADER = "x-stage-stream";
const STAGE_STREAM_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

type ParsedChatRequest = {
  taskId: string;
  message: string;
  files: File[];
  parseDurationMs: number;
};

type ExecuteChatOptions = {
  parsed: ParsedChatRequest;
  requestSignal: AbortSignal;
  emit?: (event: StageStreamEvent) => Promise<void> | void;
};

type ExecuteChatResult = {
  payload: ChatResponsePayload;
  totalDurationMs: number;
  lastSafeStage?: StageName;
  markdownCommitted: boolean;
};

class CancelledTaskError extends Error {
  lastSafeStage?: StageName;
  markdownCommitted: boolean;

  constructor(lastSafeStage?: StageName, markdownCommitted = false) {
    super("Request cancelled.");
    this.name = "CancelledTaskError";
    this.lastSafeStage = lastSafeStage;
    this.markdownCommitted = markdownCommitted;
  }
}

class ChatExecutionError extends Error {
  stage: StageName | "unknown";

  constructor(message: string, stage: StageName | "unknown") {
    super(message);
    this.name = "ChatExecutionError";
    this.stage = stage;
  }
}

function wantsStageStream(request: Request) {
  const header = request.headers.get(STAGE_STREAM_HEADER);
  const accept = request.headers.get("accept") || "";
  return header === "1" || accept.includes("application/x-ndjson");
}

function matchesExtension(file: File, extensions: string[]) {
  const normalizedName = file.name.toLowerCase();
  return extensions.some((extension) => normalizedName.endsWith(extension));
}

function isImageFile(file: File) {
  return file.type.startsWith("image/") || matchesExtension(file, IMAGE_EXTENSIONS);
}

function isAudioFile(file: File) {
  return file.type.startsWith("audio/") || matchesExtension(file, AUDIO_EXTENSIONS);
}

async function fileToDataUrl(file: File) {
  const buffer = Buffer.from(await file.arrayBuffer());
  return `data:${file.type};base64,${buffer.toString("base64")}`;
}

type MarkdownPersistencePolicy = {
  persistRecentInteractions: boolean;
  persistLongTermMemory: boolean;
  persistOwnerProfile: boolean;
};

function isPersistablePatrolTurn(routeName: string, message: string) {
  if (routeName === "multimodal_patrol") {
    return true;
  }

  if (routeName !== "text_patrol") {
    return false;
  }

  const normalized = message.trim();
  if (!normalized) {
    return false;
  }

  const explicitPatrolSignals = ["系统事件", "巡视", "巡视画面", "当前画面"];
  if (explicitPatrolSignals.some((signal) => normalized.includes(signal))) {
    return true;
  }

  const sceneSignals = ["客厅", "餐桌", "书桌", "桌面", "公共区域", "环境"];
  const evaluationSignals = ["提醒", "打扰", "整洁", "异常", "值得", "是否需要"];

  return (
    sceneSignals.some((signal) => normalized.includes(signal)) &&
    evaluationSignals.some((signal) => normalized.includes(signal))
  );
}

function resolveMarkdownPersistencePolicy(routeName: string, message: string): MarkdownPersistencePolicy {
  switch (routeName) {
    case "text_patrol":
      if (!isPersistablePatrolTurn(routeName, message)) {
        return {
          persistRecentInteractions: false,
          persistLongTermMemory: false,
          persistOwnerProfile: false
        };
      }
      return {
        persistRecentInteractions: true,
        persistLongTermMemory: true,
        persistOwnerProfile: false
      };
    case "multimodal_patrol":
      return {
        persistRecentInteractions: true,
        persistLongTermMemory: true,
        persistOwnerProfile: false
      };
    case "profile_capture":
      return {
        persistRecentInteractions: false,
        persistLongTermMemory: true,
        persistOwnerProfile: true
      };
    default:
      return {
        persistRecentInteractions: false,
        persistLongTermMemory: false,
        persistOwnerProfile: false
      };
  }
}

function nowIso() {
  return new Date().toISOString();
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function isCancelledTaskError(error: unknown): error is CancelledTaskError {
  return error instanceof CancelledTaskError;
}

function isChatExecutionError(error: unknown): error is ChatExecutionError {
  return error instanceof ChatExecutionError;
}

async function parseChatRequest(request: Request): Promise<ParsedChatRequest> {
  const parseStartedAt = Date.now();
  const formData = await request.formData();

  return {
    taskId: String(formData.get("taskId") || "").trim(),
    message: String(formData.get("message") || ""),
    files: formData.getAll("files").filter((value): value is File => value instanceof File),
    parseDurationMs: Date.now() - parseStartedAt
  };
}

function stageEvent(
  stage: StageName,
  status: StageStatus,
  label: string,
  durationMs?: number,
  meta?: Record<string, unknown>
): StageStreamStageEvent {
  return {
    type: "stage",
    stage,
    status,
    label,
    ts: nowIso(),
    durationMs,
    meta
  };
}

async function executeChatRequest({
  parsed,
  requestSignal,
  emit
}: ExecuteChatOptions): Promise<ExecuteChatResult> {
  const requestStartedAt = Date.now();
  const { taskId, message, files, parseDurationMs } = parsed;
  let lastSafeStage: StageName | undefined;
  let currentStage: StageName | "unknown" = "accepted";
  let markdownCommitted = false;
  let completed = false;

  const taskController = new AbortController();

  const emitEvent = async (event: StageStreamEvent) => {
    await emit?.(event);
  };

  const ensureNotCancelled = () => {
    if (requestSignal.aborted || isTaskCancelled(taskId)) {
      throw new CancelledTaskError(lastSafeStage, markdownCommitted);
    }
  };

  try {
    initializeRuntimeSignals();
    registerTask(taskId, () => taskController.abort());
    requestSignal.addEventListener(
      "abort",
      () => {
        requestTaskCancellation(taskId, "client_disconnect");
      },
      { once: true }
    );

    ensureNotCancelled();

    const imageFiles = files.filter(isImageFile);
    const audioFiles = files.filter(isAudioFile);

    await emitEvent(
      stageEvent("accepted", "completed", "已接收请求并完成输入解析。", parseDurationMs, {
        hasText: Boolean(message.trim()),
        imageCount: imageFiles.length,
        audioCount: audioFiles.length
      })
    );
    lastSafeStage = "accepted";

    currentStage = "routing";
    await emitEvent(stageEvent("routing", "started", "正在命中路由并选择 Markdown 上下文..."));
    const routeStartedAt = Date.now();
    const imageDataUrls = await Promise.all(imageFiles.map(fileToDataUrl));
    const contextBundle = await resolveContextBundle({
      message,
      imageDataUrls,
      audioNames: audioFiles.map((file) => file.name)
    });
    const routeDurationMs = Date.now() - routeStartedAt;
    await emitEvent(
      stageEvent(
        "routing",
        "completed",
        `已命中路由：${contextBundle.routeName}`,
        routeDurationMs,
        {
          routeName: contextBundle.routeName,
          routeDescription: contextBundle.description,
          toolName: contextBundle.toolName,
          selectedSources: contextBundle.selectedSources,
          contextCharCount: contextBundle.contextCharCount,
          modelOptions: contextBundle.modelOptions
        }
      )
    );
    lastSafeStage = "routing";

    ensureNotCancelled();

    let toolResult: ToolExecutionResult | undefined;
    currentStage = "tool";
    if (contextBundle.toolName) {
      await emitEvent(
        stageEvent(
          "tool",
          "started",
          `正在调用工具：${contextBundle.toolName}`,
          undefined,
          {
            toolName: contextBundle.toolName
          }
        )
      );

      const toolStartedAt = Date.now();
      try {
        toolResult = await executeToolForRoute({
          toolName: contextBundle.toolName,
          message,
          imageDataUrls,
          signal: taskController.signal
        });
      } catch (toolError) {
        const toolMessage =
          toolError instanceof Error ? toolError.message : "Unknown tool error.";
        toolResult = {
          toolName: contextBundle.toolName,
          status: "error",
          summary: `工具调用失败：${toolMessage}`,
          sourceLabel: "tool_runtime",
          output: {
            error: toolMessage
          }
        };
      }

      const toolDurationMs = Date.now() - toolStartedAt;
      const cacheStatus =
        typeof toolResult.output.cache_status === "string"
          ? toolResult.output.cache_status
          : undefined;
      const signalMode =
        typeof toolResult.output.signal_mode === "string"
          ? toolResult.output.signal_mode
          : undefined;
      const signalFreshness =
        typeof toolResult.output.signal_freshness === "string"
          ? toolResult.output.signal_freshness
          : undefined;
      const toolLabel =
        signalMode === "immediate_local"
          ? `已读取本地即时值：${toolResult.toolName}`
          : signalMode === "state_mirror"
            ? `已读取本地状态镜像：${toolResult.toolName}`
            : signalMode === "ttl_snapshot" && cacheStatus === "fresh_cache"
              ? `已命中本地快照并完成工具调用：${toolResult.toolName}`
              : signalMode === "ttl_snapshot" && cacheStatus === "stale_fallback"
                ? `本地快照已过期，当前退化到最近一次成功结果：${toolResult.toolName}`
                : cacheStatus === "fresh_cache"
                  ? `已命中查询缓存并完成工具调用：${toolResult.toolName}`
                  : cacheStatus === "stale_fallback"
                    ? `外部检索不可用，当前退化到最近一次成功缓存：${toolResult.toolName}`
                : `已完成工具调用：${toolResult.toolName}`;

      await emitEvent(
        stageEvent("tool", "completed", toolLabel, toolDurationMs, {
          toolName: toolResult.toolName,
          toolStatus: toolResult.status,
          sourceLabel: toolResult.sourceLabel,
          sourceType: toolResult.sourceType,
          signalMode,
          signalFreshness,
          cacheStatus,
          sourceCount: toolResult.sources?.length ?? 0
        })
      );
    } else {
      await emitEvent(
        stageEvent("tool", "skipped", "本轮未调用外部工具。", 0, {
          reason: "route_without_tool"
        })
      );
    }
    lastSafeStage = "tool";

    ensureNotCancelled();

    currentStage = "response";
    await emitEvent(
      stageEvent("response", "started", "正在组织最终回复...", undefined, {
        mode:
          contextBundle.responseMode === "local_direct"
            ? "local_direct"
            : contextBundle.toolName
              ? "tool_aware"
              : "model_only"
      })
    );
    const responseStartedAt = Date.now();
    const modelResult =
      contextBundle.responseMode === "local_direct"
        ? buildLocalDirectResult({
            routeName: contextBundle.routeName,
            toolResult,
            userMessage: message
          })
        : await requestModel(
            {
              message,
              imageDataUrls,
              audioNames: audioFiles.map((file) => file.name)
            },
            contextBundle,
            toolResult,
            taskController.signal
          );
    const responseDurationMs = Date.now() - responseStartedAt;
    await emitEvent(
      stageEvent(
        "response",
        modelResult.generationMode === "tool_fallback" ? "fallback" : "completed",
        modelResult.generationMode === "tool_fallback"
          ? "模型生成失败，已切换为工具结果兜底回复。"
          : modelResult.generationMode === "local_direct"
            ? "已通过本地直出生成最终回复。"
          : "已完成最终回复组织。",
        responseDurationMs,
        {
          generationMode: modelResult.generationMode
        }
      )
    );
    lastSafeStage = "response";

    const persistencePolicy = resolveMarkdownPersistencePolicy(
      contextBundle.routeName,
      message
    );
    let state = undefined;
    let writeDurationMs = 0;
    let uiStateDurationMs = 0;

    const sanitizedStructured: StructuredResponse = contextBundle.toolName
      ? {
          ...modelResult.structured,
          memory_update: "无新增长期记忆"
        }
      : modelResult.structured;
    const execution = buildExecutionInfo({
      structured: sanitizedStructured,
      routeName: contextBundle.routeName,
      warning: contextBundle.warning
    });

    if (
      !persistencePolicy.persistRecentInteractions &&
      !persistencePolicy.persistLongTermMemory &&
      !persistencePolicy.persistOwnerProfile
    ) {
      currentStage = "commit";
      await emitEvent(
        stageEvent("commit", "skipped", "本轮属于运行态查询，已跳过 Markdown 持久化。", 0, {
          routeName: contextBundle.routeName
        })
      );
      currentStage = "state_refresh";
      await emitEvent(
        stageEvent(
          "state_refresh",
          "skipped",
          "本轮未进入持久记忆写回，右侧 Persistent Memory 保持不变。",
          0
        )
      );
    } else {
      await waitForCancellationWindow(250);
      ensureNotCancelled();

      if (!beginTaskCommit(taskId)) {
        throw new CancelledTaskError(lastSafeStage, markdownCommitted);
      }

      currentStage = "commit";
      await emitEvent(
        stageEvent("commit", "started", "正在写回持久记忆层 Markdown...", undefined, {
          routeName: contextBundle.routeName,
          persistRecentInteractions: persistencePolicy.persistRecentInteractions,
          persistLongTermMemory: persistencePolicy.persistLongTermMemory,
          persistOwnerProfile: persistencePolicy.persistOwnerProfile
        })
      );
      const writeStartedAt = Date.now();
      const writeResult = await updateMarkdownState(
        message || "系统仅上传了一张巡视图片。",
        sanitizedStructured,
        persistencePolicy
      );
      writeDurationMs = Date.now() - writeStartedAt;
      markdownCommitted =
        writeResult.recentInteractionsUpdated ||
        writeResult.longTermMemoryUpdated ||
        writeResult.ownerProfileUpdated;

      await emitEvent(
        stageEvent(
          "commit",
          markdownCommitted ? "completed" : "skipped",
          markdownCommitted
            ? "已完成持久记忆层写回。"
            : "本轮未形成需要落盘的持久记忆，已跳过写回。",
          writeDurationMs,
          {
            recentInteractionsUpdated: writeResult.recentInteractionsUpdated,
            longTermMemoryUpdated: writeResult.longTermMemoryUpdated,
            ownerProfileUpdated: writeResult.ownerProfileUpdated
          }
        )
      );

      if (writeResult.longTermMemoryUpdated || writeResult.ownerProfileUpdated) {
        currentStage = "state_refresh";
        await emitEvent(
          stageEvent(
            "state_refresh",
            "started",
            "正在刷新右侧 Persistent Memory..."
          )
        );
        const uiStateStartedAt = Date.now();
        state = await readUiState();
        uiStateDurationMs = Date.now() - uiStateStartedAt;
        await emitEvent(
          stageEvent(
            "state_refresh",
            "completed",
            "已刷新右侧 Persistent Memory。",
            uiStateDurationMs
          )
        );
      } else {
        currentStage = "state_refresh";
        await emitEvent(
          stageEvent(
            "state_refresh",
            "skipped",
            "本轮未更新持久记忆，右侧 Persistent Memory 保持不变。",
            0
          )
        );
      }
    }
    lastSafeStage = "commit";

    lastSafeStage = "state_refresh";

    const totalDurationMs = Date.now() - requestStartedAt;

    console.info(
      "[teacher-pilot][context-routing]",
      JSON.stringify({
        routeName: contextBundle.routeName,
        routeDescription: contextBundle.description,
        toolName: toolResult?.toolName,
        toolStatus: toolResult?.status,
        responseMode: contextBundle.responseMode,
        generationMode: modelResult.generationMode,
        selectedSources: contextBundle.selectedSources,
        contextCharCount: contextBundle.contextCharCount,
        modelOptions: contextBundle.modelOptions,
        parseDurationMs,
        routeDurationMs,
        responseDurationMs,
        writeDurationMs,
        uiStateDurationMs,
        totalDurationMs
      })
    );

    const payload = {
      ok: true,
      reply: sanitizedStructured.reply,
      structured: sanitizedStructured,
      execution,
      state,
      tool: toolResult,
      warning: contextBundle.warning
    } satisfies ChatResponsePayload;

    markTaskCompleted(taskId);
    completed = true;

    return {
      payload,
      totalDurationMs,
      lastSafeStage,
      markdownCommitted
    };
  } catch (error) {
    if (requestSignal.aborted || isAbortError(error) || isTaskCancelled(taskId)) {
      throw new CancelledTaskError(lastSafeStage, markdownCommitted);
    }

    const messageText =
      error instanceof Error ? error.message : "Unknown server error.";
    throw new ChatExecutionError(messageText, currentStage);
  } finally {
    if (!completed) {
      clearTask(taskId);
    }
  }
}

function createStageStreamResponse(run: (emit: (event: StageStreamEvent) => Promise<void>) => Promise<void>) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = async (event: StageStreamEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        await run(emit);
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": STAGE_STREAM_CONTENT_TYPE,
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no"
    }
  });
}

export async function POST(request: Request) {
  let parsed: ParsedChatRequest;

  try {
    parsed = await parseChatRequest(request);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown server error.";
    return Response.json(
      {
        ok: false,
        error: message
      },
      { status: 500 }
    );
  }

  if (!parsed.taskId) {
    return Response.json(
      {
        ok: false,
        error: "Missing taskId."
      },
      { status: 400 }
    );
  }

  if (!parsed.message.trim() && parsed.files.length === 0) {
    return Response.json(
      {
        ok: false,
        error: "请至少输入一条系统事件说明，或上传一张巡视图片。"
      },
      { status: 400 }
    );
  }

  if (wantsStageStream(request)) {
    return createStageStreamResponse(async (emit) => {
      try {
        const result = await executeChatRequest({
          parsed,
          requestSignal: request.signal,
          emit
        });

        await emit({
          type: "completed",
          ts: nowIso(),
          totalDurationMs: result.totalDurationMs,
          payload: result.payload
        } satisfies StageStreamCompletedEvent);
      } catch (error) {
        if (isCancelledTaskError(error)) {
          await emit({
            type: "cancelled",
            ts: nowIso(),
            lastSafeStage: error.lastSafeStage,
            markdownCommitted: error.markdownCommitted
          } satisfies StageStreamCancelledEvent);
          return;
        }

        const stage = isChatExecutionError(error) ? error.stage : "unknown";
        const message =
          error instanceof Error ? error.message : "Unknown server error.";

        console.error("[teacher-pilot][context-routing][stream-error]", message);

        await emit({
          type: "error",
          stage,
          ts: nowIso(),
          message
        } satisfies StageStreamErrorEvent);
      }
    });
  }

  try {
    const result = await executeChatRequest({
      parsed,
      requestSignal: request.signal
    });

    return Response.json(result.payload);
  } catch (error) {
    if (isCancelledTaskError(error)) {
      console.info("[teacher-pilot][context-routing][aborted]");
      return new Response(null, { status: 499 });
    }

    const message =
      error instanceof Error ? error.message : "Unknown server error.";

    console.error("[teacher-pilot][context-routing][error]", message);

    return Response.json(
      {
        ok: false,
        error: message
      },
      { status: 500 }
    );
  }
}
