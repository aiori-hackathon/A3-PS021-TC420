import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "./config.js";
import { CanonicalEnvelope, hashPayload } from "./envelope.js";
import {
  DialogState,
  actionToTargetState,
  validateTransition,
  IllegalTransitionError
} from "./stateMachine.js";
import { faultInjector } from "../faults/faultInjector.js";

export type EngineResult =
  | {
      success: true;
      dialog_id: string;
      task_id: string;
      state: DialogState;
      seq: number;
      attempts: number;
      is_duplicate: boolean;
      effect_executed: boolean;
      data: Record<string, unknown>;
    }
  | {
      success: false;
      error: "REQUEST_ID_CONFLICT";
      message: string;
    }
  | {
      success: false;
      error: "ILLEGAL_TRANSITION";
      fromState: DialogState;
      targetState: DialogState;
      message: string;
    }
  | {
      success: false;
      error: "SCHEMA_VERSION_MISMATCH";
      message: string;
    }
  | {
      success: false;
      error: "INTERNAL_ERROR";
      message: string;
    };

export class DialogEngine {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    console.log(`[ENGINE_INIT] Initialized DialogEngine. Schema Version: "${SCHEMA_VERSION}"`);
  }

  /**
   * Main entry point for handling an incoming canonical envelope.
   * Runs inside a single SQLite transaction (BEGIN IMMEDIATE) to guarantee atomic durability.
   *
   * Honest model: At-least-once transport delivery + idempotent receiver = effectively-once side effects.
   */
  public handle(envelope: CanonicalEnvelope): EngineResult {
    const now = new Date().toISOString();
    const payloadHash = hashPayload(envelope.payload);

    // Guard: Schema version check
    if (envelope.schema_version !== SCHEMA_VERSION) {
      console.warn(`[ENGINE] Rejected envelope: Schema mismatch. Expected "${SCHEMA_VERSION}", received "${envelope.schema_version}"`);
      return {
        success: false,
        error: "SCHEMA_VERSION_MISMATCH",
        message: `Schema version mismatch. Expected '${SCHEMA_VERSION}', got '${envelope.schema_version}'`
      };
    }

    // Fault injection check: DROP_BEFORE_ACK
    if (faultInjector.shouldDropBeforeAck()) {
      console.warn(`[ENGINE_FAULT] DROP_BEFORE_ACK active: Simulating network disconnection before processing envelope.`);
      throw new Error("NETWORK_DISCONNECTED_BEFORE_ACK");
    }

    // Begin single atomic transaction
    this.db.exec("BEGIN IMMEDIATE;");

    try {
      // 1. Look up (dialog_id, request_id) in requests
      const checkReqStmt = this.db.prepare(
        "SELECT payload_hash, response_json, attempts FROM requests WHERE dialog_id = ? AND request_id = ?"
      );
      const existingReq = checkReqStmt.get(envelope.dialog_id, envelope.request_id) as
        | { payload_hash: string; response_json: string; attempts: number }
        | undefined;

      if (existingReq) {
        // 2. Duplicate path: Same request_id already recorded
        if (existingReq.payload_hash === payloadHash) {
          const newAttempts = existingReq.attempts + 1;
          const updateAttemptsStmt = this.db.prepare(
            "UPDATE requests SET attempts = ? WHERE dialog_id = ? AND request_id = ?"
          );
          updateAttemptsStmt.run(newAttempts, envelope.dialog_id, envelope.request_id);

          this.db.exec("COMMIT;");

          const cachedResponse = JSON.parse(existingReq.response_json);
          console.log(
            `[ENGINE_IDEMPOTENCY] Duplicate request detected for dialog='${envelope.dialog_id}', request='${envelope.request_id}'. Attempts incremented to ${newAttempts}. Suppressing side effect and returning cached response.`
          );

          return {
            ...cachedResponse,
            attempts: newAttempts,
            is_duplicate: true,
            effect_executed: false
          };
        } else {
          // 3. Conflict path: Same request_id with differing payload
          this.db.exec("ROLLBACK;");
          console.error(
            `[ENGINE_CONFLICT] REQUEST_ID_CONFLICT for dialog='${envelope.dialog_id}', request='${envelope.request_id}'. Payload hash differs from stored record.`
          );
          return {
            success: false,
            error: "REQUEST_ID_CONFLICT",
            message: `Request ID '${envelope.request_id}' has already been processed for dialog '${envelope.dialog_id}' with different payload.`
          };
        }
      }

      // 4. New request path: Retrieve or initialize dialog state
      const checkDialogStmt = this.db.prepare(
        "SELECT state, seq, task_id FROM dialogs WHERE dialog_id = ?"
      );
      const existingDialog = checkDialogStmt.get(envelope.dialog_id) as
        | { state: DialogState; seq: number; task_id: string }
        | undefined;

      const currentState: DialogState = existingDialog ? existingDialog.state : "CREATED";
      const targetState: DialogState = actionToTargetState(envelope.action);

      // Validate correlation integrity: task_id must be stable for the same dialog_id
      if (existingDialog && existingDialog.task_id !== envelope.task_id) {
        this.db.exec("ROLLBACK;");
        return {
          success: false,
          error: "INTERNAL_ERROR",
          message: `Dialog correlation conflict: dialog '${envelope.dialog_id}' is bound to task '${existingDialog.task_id}', but request specified task '${envelope.task_id}'`
        };
      }

      // Validate transition against state machine
      const transitionValidation = validateTransition(currentState, targetState, envelope.action);
      if (!transitionValidation.valid) {
        // Reject without writing a requests row
        this.db.exec("ROLLBACK;");
        console.warn(
          `[ENGINE_REJECT] Rejected illegal transition for dialog='${envelope.dialog_id}' from '${currentState}' to '${targetState}' via action '${envelope.action}'`
        );
        return {
          success: false,
          error: "ILLEGAL_TRANSITION",
          fromState: currentState,
          targetState,
          message: transitionValidation.error.message
        };
      }

      // 5. Legal transition: update dialog state, execute mock side effect, record request
      let newSeq = 1;
      if (!existingDialog) {
        const insertDialogStmt = this.db.prepare(
          "INSERT INTO dialogs (dialog_id, task_id, state, seq, origin_adapter, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        );
        insertDialogStmt.run(
          envelope.dialog_id,
          envelope.task_id,
          targetState,
          newSeq,
          envelope.origin_adapter,
          SCHEMA_VERSION,
          now,
          now
        );
      } else {
        newSeq = existingDialog.seq + 1;
        const updateDialogStmt = this.db.prepare(
          "UPDATE dialogs SET state = ?, seq = ?, updated_at = ? WHERE dialog_id = ?"
        );
        updateDialogStmt.run(targetState, newSeq, now, envelope.dialog_id);
      }

      const effectType = `EXECUTE_ACTION_${envelope.action}`;
      const effectData = JSON.stringify({
        action: envelope.action,
        origin_adapter: envelope.origin_adapter,
        payload: envelope.payload,
        dispatched_at: now
      });

      // Insert side effect (guaranteed unique by (dialog_id, request_id, effect_type) constraint)
      const insertEffectStmt = this.db.prepare(
        "INSERT INTO side_effects (dialog_id, request_id, effect_type, effect_data, created_at) VALUES (?, ?, ?, ?, ?)"
      );
      insertEffectStmt.run(envelope.dialog_id, envelope.request_id, effectType, effectData, now);

      const responseData: EngineResult = {
        success: true,
        dialog_id: envelope.dialog_id,
        task_id: envelope.task_id,
        state: targetState,
        seq: newSeq,
        attempts: 1,
        is_duplicate: false,
        effect_executed: true,
        data: {
          action: envelope.action,
          executed_effect: effectType,
          timestamp: now
        }
      };

      // Store in requests table
      const insertReqStmt = this.db.prepare(
        "INSERT INTO requests (dialog_id, request_id, payload_hash, response_json, attempts, first_seen_at) VALUES (?, ?, ?, ?, 1, ?)"
      );
      insertReqStmt.run(envelope.dialog_id, envelope.request_id, payloadHash, JSON.stringify(responseData), now);

      // Commit transaction atomically
      this.db.exec("COMMIT;");

      console.log(
        `[ENGINE_TRANSITION] Committed: dialog='${envelope.dialog_id}' (${currentState} -> ${targetState}), seq=${newSeq}, request='${envelope.request_id}', effect='${effectType}'`
      );

      // Fault injection check: CRASH_MID_WORKING
      if (envelope.action === "START_WORK" && faultInjector.shouldCrashMidWorking()) {
        console.warn(`[ENGINE_FAULT] Process crash triggered mid-WORKING! Exiting process now.`);
        process.exit(1);
      }

      // Fault injection check: DROP_AFTER_COMMIT
      if (faultInjector.shouldDropAfterCommit()) {
        console.warn(`[ENGINE_FAULT] DROP_AFTER_COMMIT triggered: Transaction committed to SQLite, but dropping HTTP response.`);
        throw new Error("NETWORK_DISCONNECTED_AFTER_COMMIT");
      }

      return responseData;
    } catch (err) {
      // If error occurs and transaction is still active, rollback
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // Rollback may fail if transaction already aborted or committed
      }
      throw err;
    }
  }

  /**
   * Diagnostic helper to inspect current dialog state directly from DB.
   */
  public getDialog(dialog_id: string): { dialog_id: string; task_id: string; state: DialogState; seq: number } | undefined {
    const stmt = this.db.prepare("SELECT dialog_id, task_id, state, seq FROM dialogs WHERE dialog_id = ?");
    return stmt.get(dialog_id) as any;
  }

  /**
   * Diagnostic helper to count side effects recorded for a given dialog.
   */
  public getSideEffectsCount(dialog_id: string): number {
    const stmt = this.db.prepare("SELECT COUNT(*) as cnt FROM side_effects WHERE dialog_id = ?");
    const row = stmt.get(dialog_id) as { cnt: number };
    return row.cnt;
  }

  /**
   * Diagnostic helper to retrieve request row.
   */
  public getRequest(dialog_id: string, request_id: string): { attempts: number; payload_hash: string } | undefined {
    const stmt = this.db.prepare("SELECT attempts, payload_hash FROM requests WHERE dialog_id = ? AND request_id = ?");
    return stmt.get(dialog_id, request_id) as any;
  }
}
