import { SCHEMA_VERSION } from "../core/config.js";
import { CanonicalEnvelope, DialogAction } from "../core/envelope.js";
import { EngineResult } from "../core/engine.js";

/**
 * Adapter A: Mock "MCP-Style" Adapter
 *
 * Simulates a Model Context Protocol JSON-RPC 2.0 style client/gateway.
 * NOTE: This is a standalone MOCK for prototype evaluation.
 * Honest non-claim: Does not implement full MCP specification or official SDKs.
 */

export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method:
    | "tools/call"
    | "dialog/submit"
    | "dialog/ack"
    | "dialog/start_work"
    | "dialog/request_input"
    | "dialog/resume_work"
    | "dialog/complete"
    | "dialog/cancel";
  params: {
    dialog_id: string;
    task_id: string;
    seq: number;
    arguments: Record<string, unknown>;
  };
}

export interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export class AdapterAMcpClient {
  private baseUrl: string;

  constructor(baseUrl: string = "http://127.0.0.1:4200") {
    this.baseUrl = baseUrl;
  }

  /**
   * Translates an MCP-style JSON-RPC method to a canonical DialogAction.
   */
  public static mapMethodToAction(method: McpJsonRpcRequest["method"]): DialogAction {
    switch (method) {
      case "dialog/submit":
        return "SUBMIT";
      case "dialog/ack":
        return "ACK";
      case "dialog/start_work":
      case "tools/call":
        return "START_WORK";
      case "dialog/request_input":
        return "REQUEST_INPUT";
      case "dialog/resume_work":
        return "RESUME_WORK";
      case "dialog/complete":
        return "COMPLETE";
      case "dialog/cancel":
        return "CANCEL";
    }
  }

  /**
   * Converts an MCP JSON-RPC request to the system's CanonicalEnvelope.
   */
  public toCanonicalEnvelope(mcpReq: McpJsonRpcRequest): CanonicalEnvelope {
    return {
      schema_version: SCHEMA_VERSION,
      dialog_id: mcpReq.params.dialog_id,
      task_id: mcpReq.params.task_id,
      request_id: mcpReq.id,
      seq: mcpReq.params.seq,
      action: AdapterAMcpClient.mapMethodToAction(mcpReq.method),
      payload: mcpReq.params.arguments,
      origin_adapter: "adapter-a-mcp"
    };
  }

  /**
   * Sends an MCP request over HTTP to the core engine, translating to/from canonical envelopes.
   */
  public async send(mcpReq: McpJsonRpcRequest): Promise<McpJsonRpcResponse> {
    const envelope = this.toCanonicalEnvelope(mcpReq);

    console.log(
      `[ADAPTER_A_MCP] Outgoing JSON-RPC id=${mcpReq.id}, method=${mcpReq.method} -> Canonical dialog=${envelope.dialog_id}, action=${envelope.action}`
    );

    const res = await fetch(`${this.baseUrl}/api/dialog/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope)
    });

    const data = (await res.json()) as EngineResult;

    if (!res.ok || !data.success) {
      console.warn(`[ADAPTER_A_MCP] Received error response from engine:`, data);
      return {
        jsonrpc: "2.0",
        id: mcpReq.id,
        error: {
          code: -32000,
          message: (data as any).message || "Request failed",
          data
        }
      };
    }

    return {
      jsonrpc: "2.0",
      id: mcpReq.id,
      result: {
        dialog_id: data.dialog_id,
        task_id: data.task_id,
        state: data.state,
        seq: data.seq,
        attempts: data.attempts,
        is_duplicate: data.is_duplicate,
        effect_executed: data.effect_executed,
        ...data.data
      }
    };
  }
}
