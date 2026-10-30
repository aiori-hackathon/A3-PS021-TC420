/**
 * Central configuration for the Experimental Dialog Correlation engine.
 *
 * NOTE: Schema version string is explicitly pinned here per PS-021 requirements.
 * Model: At-least-once transport delivery + idempotent receiver = effectively-once side effects.
 * Non-claims: Not an IETF standard, not full MCP/A2A interoperability, no physical exactly-once delivery.
 */

export const SCHEMA_VERSION = "EXPERIMENTAL DRAFT v0, schema version pending mentor pinning";

export const CONFIG = {
  SCHEMA_VERSION,
  DEFAULT_PORT: 4200,
  DEFAULT_HOST: "127.0.0.1",
  DEFAULT_DB_PATH: "./dialog_store.db",
  DELIVERY_MODEL: "at-least-once transport + idempotent receiver = effectively-once side effects within prototype"
};
