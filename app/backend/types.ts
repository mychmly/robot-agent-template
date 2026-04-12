export type StructuredResponse = {
  reply: string;
  intent: string;
  decision: string;
  action: string;
  reason: string;
  memory_update: string;
};

export type ExecutionActionType =
  | "NO_OP"
  | "NOTIFY_USER"
  | "REQUEST_MORE_INFO"
  | "ASK_HUMAN_CONFIRM"
  | "ESCALATE_TO_HUMAN";

export type ExecutionMode = "simulated" | "human_proxy" | "tool_stub";

export type ExecutionRiskLevel = "low" | "medium" | "high";

export type ExecutionInfo = {
  action_type: ExecutionActionType;
  execution_mode: ExecutionMode;
  instruction: string;
  requires_confirmation: boolean;
  risk_level: ExecutionRiskLevel;
};

export type StageName =
  | "accepted"
  | "routing"
  | "tool"
  | "response"
  | "commit"
  | "state_refresh";

export type StageStatus = "started" | "completed" | "skipped" | "fallback";

export type StageEventMeta = Record<string, unknown>;

export type StageStreamStageEvent = {
  type: "stage";
  stage: StageName;
  status: StageStatus;
  label: string;
  ts: string;
  durationMs?: number;
  meta?: StageEventMeta;
};

export type StageStreamCompletedEvent = {
  type: "completed";
  ts: string;
  totalDurationMs: number;
  payload: ChatResponsePayload;
};

export type StageStreamErrorEvent = {
  type: "error";
  stage: StageName | "unknown";
  ts: string;
  message: string;
};

export type StageStreamCancelledEvent = {
  type: "cancelled";
  ts: string;
  lastSafeStage?: StageName;
  markdownCommitted: boolean;
};

export type StageStreamEvent =
  | StageStreamStageEvent
  | StageStreamCompletedEvent
  | StageStreamErrorEvent
  | StageStreamCancelledEvent;

export type RuntimeSignalKey =
  | "time_now"
  | "current_location"
  | "weather_lookup"
  | "home_environment_status";

export type ToolName =
  | "time_now"
  | "current_location"
  | "weather_lookup"
  | "home_environment_status"
  | "web_search";

export type ToolStatus = "success" | "error";

export type ToolSourceLink = {
  title: string;
  url: string;
};

export type ToolExecutionResult = {
  toolName: ToolName;
  status: ToolStatus;
  summary: string;
  sourceLabel: string;
  sourceType?: string;
  output: Record<string, unknown>;
  sources?: ToolSourceLink[];
};

export type UiState = {
  ownerProfile: string;
  longTermMemory: string;
};

export type ChatResponsePayload = {
  ok: boolean;
  reply?: string;
  structured?: StructuredResponse;
  execution?: ExecutionInfo;
  state?: UiState;
  tool?: ToolExecutionResult;
  warning?: string;
  error?: string;
};
