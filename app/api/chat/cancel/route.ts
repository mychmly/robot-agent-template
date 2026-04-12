import { getTaskState, requestTaskCancellation } from "../../../backend/task-registry";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { taskId?: string };
    const taskId = body.taskId?.trim();

    if (!taskId) {
      return Response.json(
        {
          ok: false,
          error: "Missing taskId."
        },
        { status: 400 }
      );
    }

    const result = requestTaskCancellation(taskId, "user_cancelled");

    return Response.json({
      ok: true,
      cancelled: result.accepted,
      state: getTaskState(taskId)
    });
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
}
