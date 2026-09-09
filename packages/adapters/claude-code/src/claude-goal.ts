import type {
  HarnessError,
  HostGoal,
  HostGoalOutcome,
  SessionGoalChangedEvent,
} from "@codexhost/harness-adapter";

import type { ClaudeGoalSignal } from "./transport.js";

/** Claude Code caps `/goal` conditions at this many characters. */
export const CLAUDE_GOAL_OBJECTIVE_LIMIT = 4_000;

export type ClaudeGoalCommandOutcome =
  | { kind: "set"; objective: string }
  | { kind: "cleared"; objective: string }
  | { kind: "noGoal" }
  | { kind: "active"; status: string }
  | { kind: "error"; error: HarnessError };

/** Goal state as derived from native `goal_status` transcript records. */
export interface ClaudeGoalTranscriptState {
  goal: HostGoal | null;
  outcome?: HostGoalOutcome;
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Interprets the text a native `/goal` local command prints. */
export function classifyClaudeGoalCommandOutput(output: string): ClaudeGoalCommandOutcome {
  const text = output.trim();
  if (text.startsWith("Goal set: "))
    return { kind: "set", objective: text.slice("Goal set: ".length) };
  if (text.startsWith("Goal cleared: ")) {
    return { kind: "cleared", objective: text.slice("Goal cleared: ".length) };
  }
  if (text.startsWith("No goal set")) return { kind: "noGoal" };
  if (text.startsWith("Goal active: ")) {
    return { kind: "active", status: text.slice("Goal active: ".length) };
  }
  if (text.startsWith("Goal condition is limited to ")) {
    return { kind: "error", error: { code: "invalidRequest", message: text, retryable: false } };
  }
  return { kind: "error", error: { code: "unsupported", message: text, retryable: false } };
}

/**
 * Replays Claude's persisted `goal_status` attachments in transcript order.
 *
 * Set and clear write sentinels (`met: false` and `met: true` respectively);
 * each Stop hook round appends a verdict, and the final verdict carries either
 * `met: true` or `failed: true`.
 */
export function deriveClaudeGoalFromTranscript(records: unknown[]): ClaudeGoalTranscriptState {
  let state: ClaudeGoalTranscriptState = { goal: null };
  for (const record of records) {
    if (!isRecord(record) || !isRecord(record.attachment)) continue;
    const status = record.attachment;
    if (status.type !== "goal_status" || typeof status.condition !== "string") continue;
    const reason = typeof status.reason === "string" ? status.reason : undefined;
    if (status.sentinel === true) {
      if (status.met === true) {
        state = state.goal ? { goal: null, outcome: "cleared" } : state;
        continue;
      }
      const setAtMs =
        typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
      state = {
        goal: {
          objective: status.condition,
          setAtMs: Number.isFinite(setAtMs) ? setAtMs : 0,
          iterations: 0,
        },
      };
      continue;
    }
    if (status.met === true) {
      state = { goal: null, outcome: "achieved", ...(reason ? { reason } : {}) };
      continue;
    }
    if (status.failed === true) {
      state = { goal: null, outcome: "unachievable", ...(reason ? { reason } : {}) };
      continue;
    }
    if (!state.goal) continue;
    const iterations =
      typeof status.iterations === "number" ? status.iterations : state.goal.iterations + 1;
    state = {
      goal: { ...state.goal, iterations, ...(reason ? { lastReason: reason } : {}) },
    };
  }
  return state;
}

function sameGoal(left: HostGoal | null, right: HostGoal | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.objective === right.objective &&
    left.iterations === right.iterations &&
    left.lastReason === right.lastReason
  );
}

/**
 * Tracks the Goal Claude currently holds and publishes `session.goal.changed`
 * whenever native evidence moves it. Live stream signals give immediate but
 * partial knowledge; transcript reconciliation settles terminal outcomes.
 */
export class ClaudeGoalTracker {
  #goal: HostGoal | null = null;
  readonly #emit: (event: SessionGoalChangedEvent) => void;
  readonly #now: () => number;

  constructor(emit: (event: SessionGoalChangedEvent) => void, now: () => number = Date.now) {
    this.#emit = emit;
    this.#now = now;
  }

  get goal(): HostGoal | null {
    return this.#goal;
  }

  /** Native `/goal <objective>` acknowledged with `Goal set:`. */
  confirmSet(objective: string): void {
    this.#goal = { objective, setAtMs: this.#now(), iterations: 0 };
    this.#emit({ type: "session.goal.changed", goal: this.#goal });
  }

  /** Native `/goal clear` acknowledged with `Goal cleared:`. */
  confirmCleared(): void {
    if (this.#goal === null) return;
    this.#goal = null;
    this.#emit({ type: "session.goal.changed", goal: null, outcome: "cleared" });
  }

  apply(signal: ClaudeGoalSignal): void {
    if (signal.type === "command") {
      const outcome = classifyClaudeGoalCommandOutput(signal.output);
      if (outcome.kind === "set") this.confirmSet(outcome.objective);
      else if (outcome.kind === "cleared") this.confirmCleared();
      return;
    }
    if (signal.type === "verdict") {
      if (this.#goal === null || signal.condition !== this.#goal.objective) return;
      this.#goal = {
        ...this.#goal,
        iterations: this.#goal.iterations + 1,
        ...(signal.reason ? { lastReason: signal.reason } : {}),
      };
      this.#emit({ type: "session.goal.changed", goal: this.#goal });
      return;
    }
    if (this.#goal === null) return;
    this.#goal = null;
    this.#emit({
      type: "session.goal.changed",
      goal: null,
      outcome: "error",
      reason: signal.reason,
    });
  }

  /**
   * Aligns with transcript-derived state. Emits only when the Goal actually
   * differs, so a settled Turn does not repeat live verdict updates.
   */
  reconcile(state: ClaudeGoalTranscriptState, publish = true): boolean {
    if (sameGoal(this.#goal, state.goal)) return false;
    const previous = this.#goal;
    this.#goal = state.goal;
    if (!publish) return true;
    if (state.goal) {
      this.#emit({ type: "session.goal.changed", goal: state.goal });
    } else if (previous) {
      this.#emit({
        type: "session.goal.changed",
        goal: null,
        outcome: state.outcome ?? "cleared",
        ...(state.reason ? { reason: state.reason } : {}),
      });
    }
    return true;
  }
}
