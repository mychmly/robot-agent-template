import { readUiState } from "./backend/markdown";
import { initializeRuntimeSignals } from "./backend/runtime-signals";
import { RobotAgentClient } from "./frontend/robot-agent-client";

export default async function Page() {
  initializeRuntimeSignals();
  const initialState = await readUiState();
  return <RobotAgentClient initialState={initialState} />;
}
