import type { OutboxStatus, TaskStatus } from "@agyhq/core";

/** Thrown by tasks.transition() when the requested move isn't in core's TASK_TRANSITIONS table. */
export class TaskTransitionError extends Error {
  readonly taskId: string;
  readonly from: TaskStatus;
  readonly to: TaskStatus;

  constructor(taskId: string, from: TaskStatus, to: TaskStatus) {
    super(`task ${taskId}: invalid transition ${from} -> ${to}`);
    this.name = "TaskTransitionError";
    this.taskId = taskId;
    this.from = from;
    this.to = to;
  }
}

/** Thrown by outbox.decide() when the requested move isn't in core's OUTBOX_TRANSITIONS table. */
export class OutboxTransitionError extends Error {
  readonly itemId: string;
  readonly from: OutboxStatus;
  readonly to: OutboxStatus;

  constructor(itemId: string, from: OutboxStatus, to: OutboxStatus) {
    super(`outbox ${itemId}: invalid transition ${from} -> ${to}`);
    this.name = "OutboxTransitionError";
    this.itemId = itemId;
    this.from = from;
    this.to = to;
  }
}

export class NotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

/** Generic "operation not valid in current state" error (e.g. editing a non-pending outbox item). */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
