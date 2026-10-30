import { DialogAction } from "./envelope.js";

/**
 * Dialog Lifecycle States per PS-021 specification.
 * Disconnects and network timeouts are transport events, NOT lifecycle states.
 */
export type DialogState =
  | "CREATED"
  | "SUBMITTED"
  | "ACKED"
  | "WORKING"
  | "INPUT_REQUIRED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED";

/**
 * Terminal states: Once a dialog enters any of these states,
 * no further transitions are allowed.
 */
export const TERMINAL_STATES: ReadonlySet<DialogState> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELED"
]);

/**
 * Explicit map of valid state transitions.
 * Any transition not in this map is illegal and must be rejected.
 */
export const VALID_TRANSITIONS: Record<DialogState, readonly DialogState[]> = {
  CREATED: ["SUBMITTED"],
  SUBMITTED: ["ACKED", "CANCELED"],
  ACKED: ["WORKING", "CANCELED"],
  WORKING: ["INPUT_REQUIRED", "COMPLETED", "FAILED", "CANCELED"],
  INPUT_REQUIRED: ["WORKING", "CANCELED"],
  COMPLETED: [], // Terminal
  FAILED: [],    // Terminal
  CANCELED: []   // Terminal
};

/**
 * Maps a canonical DialogAction to its resulting DialogState.
 */
export function actionToTargetState(action: DialogAction): DialogState {
  switch (action) {
    case "SUBMIT":
      return "SUBMITTED";
    case "ACK":
      return "ACKED";
    case "START_WORK":
      return "WORKING";
    case "REQUEST_INPUT":
      return "INPUT_REQUIRED";
    case "RESUME_WORK":
      return "WORKING";
    case "COMPLETE":
      return "COMPLETED";
    case "FAIL":
      return "FAILED";
    case "CANCEL":
      return "CANCELED";
  }
}

/**
 * Typed error for rejected state transitions.
 */
export interface IllegalTransitionError {
  error: "ILLEGAL_TRANSITION";
  fromState: DialogState;
  targetState: DialogState;
  action: DialogAction;
  message: string;
}

/**
 * Validates whether a state transition from currentState to targetState is legal.
 */
export function validateTransition(
  currentState: DialogState,
  targetState: DialogState,
  action: DialogAction
): { valid: true } | { valid: false; error: IllegalTransitionError } {
  const allowed = VALID_TRANSITIONS[currentState] || [];
  if (allowed.includes(targetState)) {
    return { valid: true };
  }

  const error: IllegalTransitionError = {
    error: "ILLEGAL_TRANSITION",
    fromState: currentState,
    targetState,
    action,
    message: `Illegal state transition attempted: '${currentState}' -> '${targetState}' via action '${action}'. Terminal states and unlisted transitions are rejected.`
  };

  return { valid: false, error };
}
