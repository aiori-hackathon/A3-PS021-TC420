import { SCHEMA_VERSION } from "../core/config.js";
import { CanonicalEnvelope, DialogAction } from "../core/envelope.js";
import { EngineResult } from "../core/engine.js";

/**
 * Adapter B: Mock "A2A-Style" Adapter
 *
 * Simulates an Agent-to-Agent (A2A) task-based messaging adapter.
 * NOTE: This is a standalone MOCK for prototype evaluation.
 * Honest non-claim: Does not implement full A2A standard or third-party SDKs.
 */

export interface A2ATaskMessage {
  message_type:
    | "task_submit"
    | "task_ack"
    | "task_start"
    | "task_request_input"
    | "task_resume"
    | "task_complete"
    | "task_fail"
    | "task_cancel";
  message_id: string;
  task_context: {
    task_id: string;
    dialog_id: string;
    sequence_num: number;
  };
  body: {
    details: Record<string, unknown>;
  };
}

export interface A2ATaskResponse {
  message_type: "task_response" | "task_error";
  correlation_id: string;
  task_id: string;
  dialog_id: string;
  status: string;
  attempts: number;
  is_duplicate: boolean;
  effect_executed: boolean;
  details?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    data?: unknown;
  };
}

export class AdapterBA2AClient {
  private baseUrl: string;

  constructor(baseUrl: string = "http://127.0.0.1:4200") {
    this.baseUrl = baseUrl;
  }

  /**
   * Translates an A2A message type to a canonical DialogAction.
   */
  public static mapMessageTypeToAction(messageType: A2ATaskMessage["message_type"]): DialogAction {
    switch (messageType) {
      case "task_submit":
        return "SUBMIT";
      case "task_ack":
        return "ACK";
      case "task_start":
        return "START_WORK";
      case "task_request_input":
        return "REQUEST_INPUT";
      case "task_resume":
        return "RESUME_WORK";
      case "task_complete":
        return "COMPLETE";
      case "task_fail":
        return "FAIL";
      case "task_cancel":
        return "CANCEL";
    }
  }

  /**
   * Converts an A2A task message to the system's CanonicalEnvelope.
   */
  public toCanonicalEnvelope(msg: A2ATaskMessage): CanonicalEnvelope {
    return {
      schema_version: SCHEMA_VERSION,
      dialog_id: msg.task_context.dialog_id,
      task_id: msg.task_context.task_id,
      request_id: msg.message_id,
      seq: msg.task_context.sequence_num,
      action: AdapterBA2AClient.mapMessageTypeToAction(msg.message_type),
      payload: msg.body.details,
      origin_adapter: "adapter-b-a2a"
    };
  }

  /**
   * Sends an A2A message over HTTP to the core engine, translating to/from canonical envelopes.
   */
  public async send(msg: A2ATaskMessage): Promise<A2ATaskResponse> {
    const envelope = this.toCanonicalEnvelope(msg);

    console.log(
      `[ADAPTER_B_A2A] Outgoing task msg_id=${msg.message_id}, type=${msg.message_type} -> Canonical dialog=${envelope.dialog_id}, action=${envelope.action}`
    );

    const res = await fetch(`${this.baseUrl}/api/dialog/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope)
    });

    const data = (await res.json()) as EngineResult;

    if (!res.ok || !data.success) {
      console.warn(`[ADAPTER_B_A2A] Received error response from engine:`, data);
      return {
        message_type: "task_error",
        correlation_id: msg.message_id,
        task_id: msg.task_context.task_id,
        dialog_id: msg.task_context.dialog_id,
        status: "ERROR",
        attempts: 1,
        is_duplicate: false,
        effect_executed: false,
        error: {
          code: (data as any).error || "REQUEST_FAILED",
          message: (data as any).message || "Request failed",
          data
        }
      };
    }

    return {
      message_type: "task_response",
      correlation_id: msg.message_id,
      task_id: data.task_id,
      dialog_id: data.dialog_id,
      status: data.state,
      attempts: data.attempts,
      is_duplicate: data.is_duplicate,
      effect_executed: data.effect_executed,
      details: data.data
    };
  }
}
