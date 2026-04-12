import fs from "fs";
import os from "os";
import path from "path";

type TaskState = "running" | "cancel_requested" | "committing" | "completed";

type PersistedTaskEntry = {
  state: TaskState;
  updatedAt: number;
  cancelReason?: string;
};

const TASK_DIR = path.join(os.tmpdir(), "aster-teacher-task-registry");
const cancelCallbacks = new Map<string, Set<() => void>>();

function ensureTaskDir() {
  fs.mkdirSync(TASK_DIR, { recursive: true });
}

function resolveTaskPath(taskId: string) {
  ensureTaskDir();
  return path.join(TASK_DIR, `${taskId}.json`);
}

function readTaskEntry(taskId: string): PersistedTaskEntry | null {
  const fullPath = resolveTaskPath(taskId);

  if (!fs.existsSync(fullPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(fullPath, "utf8")) as PersistedTaskEntry;
}

function writeTaskEntry(taskId: string, entry: PersistedTaskEntry) {
  const fullPath = resolveTaskPath(taskId);
  fs.writeFileSync(fullPath, JSON.stringify(entry), "utf8");
}

export function registerTask(taskId: string, onCancel?: () => void) {
  const existing = readTaskEntry(taskId);

  if (onCancel) {
    if (!cancelCallbacks.has(taskId)) {
      cancelCallbacks.set(taskId, new Set());
    }

    cancelCallbacks.get(taskId)?.add(onCancel);
  }

  if (existing?.state === "cancel_requested") {
    onCancel?.();
    return;
  }

  writeTaskEntry(taskId, {
    state: "running",
    updatedAt: Date.now(),
    cancelReason: existing?.cancelReason
  });
}

export function requestTaskCancellation(taskId: string, reason = "user_cancelled") {
  const existing = readTaskEntry(taskId);

  if (existing?.state === "completed" || existing?.state === "committing") {
    return {
      accepted: false,
      state: existing.state
    } as const;
  }

  writeTaskEntry(taskId, {
    state: "cancel_requested",
    updatedAt: Date.now(),
    cancelReason: reason
  });

  for (const callback of cancelCallbacks.get(taskId) || []) {
    try {
      callback();
    } catch {
      // ignore callback failures on cancellation path
    }
  }

  return {
    accepted: true,
    state: "cancel_requested"
  } as const;
}

export function isTaskCancelled(taskId: string) {
  return readTaskEntry(taskId)?.state === "cancel_requested";
}

export function beginTaskCommit(taskId: string) {
  const existing = readTaskEntry(taskId);

  if (!existing) {
    return false;
  }

  if (existing.state === "cancel_requested" || existing.state === "completed") {
    return false;
  }

  writeTaskEntry(taskId, {
    ...existing,
    state: "committing",
    updatedAt: Date.now()
  });

  return true;
}

export function markTaskCompleted(taskId: string) {
  const existing = readTaskEntry(taskId);

  if (!existing) {
    return;
  }

  writeTaskEntry(taskId, {
    ...existing,
    state: "completed",
    updatedAt: Date.now()
  });

  cancelCallbacks.delete(taskId);
}

export function clearTask(taskId: string) {
  const fullPath = resolveTaskPath(taskId);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
  cancelCallbacks.delete(taskId);
}

export async function waitForCancellationWindow(delayMs: number) {
  if (delayMs <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function getTaskState(taskId: string) {
  return readTaskEntry(taskId)?.state || null;
}
