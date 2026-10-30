import crypto from "node:crypto";
import { SCHEMA_VERSION } from "./config.js";

/**
 * Valid actions that can be requested on a dialog.
 */
export type DialogAction =
  | "SUBMIT"
  | "ACK"
  | "START_WORK"
  | "REQUEST_INPUT"
  | "RESUME_WORK"
  | "COMPLETE"
  | "FAIL"
  | "CANCEL";

/**
 * The canonical message envelope used across all agent adapters and the core engine.
 * Both Adapter A (MCP-style) and Adapter B (A2A-style) map to/from this envelope.
 */
export interface CanonicalEnvelope {
  schema_version: string;
  dialog_id: string;
  task_id: string;
  request_id: string;
  seq: number;
  action: DialogAction;
  payload: Record<string, unknown>;
  origin_adapter: string; // e.g., "adapter-a-mcp" | "adapter-b-a2a"
}

/**
 * Computes a deterministic SHA-256 hash of a payload object by sorting keys recursively.
 * Guarantees that equivalent objects yield identical hashes for idempotency comparisons.
 */
export function hashPayload(payload: Record<string, unknown>): string {
  const normalize = (obj: unknown): unknown => {
    if (obj === null || typeof obj !== "object") {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(normalize);
    }
    const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
    const sortedObj: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      sortedObj[key] = normalize((obj as Record<string, unknown>)[key]);
    }
    return sortedObj;
  };

  const canonicalJson = JSON.stringify(normalize(payload));
  return crypto.createHash("sha256").update(canonicalJson).digest("hex");
}

/**
 * Factory helper to construct a valid CanonicalEnvelope.
 */
export function createEnvelope(params: {
  dialog_id: string;
  task_id: string;
  request_id: string;
  seq: number;
  action: DialogAction;
  payload: Record<string, unknown>;
  origin_adapter: string;
}): CanonicalEnvelope {
  return {
    schema_version: SCHEMA_VERSION,
    ...params
  };
}
