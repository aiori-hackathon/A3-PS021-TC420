import express, { Request, Response } from "express";
import { createDatabase } from "./db.js";
import { DialogEngine } from "./engine.js";
import { CanonicalEnvelope } from "./envelope.js";
import { faultInjector, FaultConfig } from "../faults/faultInjector.js";
import { CONFIG, SCHEMA_VERSION } from "./config.js";

export function createServer(dbPath: string = CONFIG.DEFAULT_DB_PATH) {
  const db = createDatabase(dbPath);
  const engine = new DialogEngine(db);
  const app = express();

  app.use(express.json());

  // Logging middleware
  app.use((req, _res, next) => {
    if (req.path.startsWith("/api/dialog/message")) {
      console.log(`[HTTP_IN] ${req.method} ${req.path} - Schema: "${SCHEMA_VERSION}"`);
    }
    next();
  });

  // Health check endpoint
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      schema_version: SCHEMA_VERSION,
      delivery_model: CONFIG.DELIVERY_MODEL
    });
  });

  // Core dialog message intake
  app.post("/api/dialog/message", (req: Request, res: Response) => {
    const envelope = req.body as CanonicalEnvelope;

    if (!envelope || !envelope.dialog_id || !envelope.request_id || !envelope.action) {
      res.status(400).json({
        success: false,
        error: "INVALID_REQUEST",
        message: "Missing required canonical envelope fields."
      });
      return;
    }

    try {
      const result = engine.handle(envelope);

      if (!result.success) {
        // Return 400 with typed error payload (REQUEST_ID_CONFLICT, ILLEGAL_TRANSITION, etc.)
        res.status(400).json(result);
        return;
      }

      res.status(200).json(result);
    } catch (err: any) {
      if (err.message === "NETWORK_DISCONNECTED_BEFORE_ACK") {
        console.warn(`[SERVER] Forcibly destroying socket before ACK per fault injector.`);
        res.socket?.destroy();
        return;
      }

      if (err.message === "NETWORK_DISCONNECTED_AFTER_COMMIT") {
        console.warn(`[SERVER] Forcibly destroying socket after COMMIT per fault injector.`);
        res.socket?.destroy();
        return;
      }

      console.error(`[SERVER_ERROR]`, err);
      res.status(500).json({
        success: false,
        error: "INTERNAL_ERROR",
        message: err.message || "Unknown internal error"
      });
    }
  });

  // Fault injection endpoints
  app.post("/api/fault/configure", (req: Request, res: Response) => {
    const config = req.body as FaultConfig;
    faultInjector.setFaults(config);
    res.json({ status: "ok", active_faults: faultInjector.getConfig() });
  });

  app.post("/api/fault/reset", (_req: Request, res: Response) => {
    faultInjector.reset();
    res.json({ status: "ok" });
  });

  // Diagnostic endpoints for testing / demo verification
  app.get("/api/dialog/:dialog_id", (req: Request, res: Response) => {
    const dialogId = String(req.params.dialog_id);
    const dialog = engine.getDialog(dialogId);
    if (!dialog) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    res.json(dialog);
  });

  app.get("/api/dialog/:dialog_id/effects", (req: Request, res: Response) => {
    const dialogId = String(req.params.dialog_id);
    const count = engine.getSideEffectsCount(dialogId);
    const stmt = db.prepare("SELECT * FROM side_effects WHERE dialog_id = ?");
    const rows = stmt.all(dialogId);
    res.json({ count, effects: rows });
  });

  app.get("/api/dialog/:dialog_id/requests", (req: Request, res: Response) => {
    const dialogId = String(req.params.dialog_id);
    const stmt = db.prepare("SELECT * FROM requests WHERE dialog_id = ?");
    const rows = stmt.all(dialogId);
    res.json({ requests: rows });
  });

  // Test reset helper to truncate tables cleanly
  app.post("/api/admin/reset", (_req: Request, res: Response) => {
    db.exec("DELETE FROM side_effects; DELETE FROM requests; DELETE FROM dialogs;");
    res.json({ status: "ok", message: "Database reset complete." });
  });

  return { app, engine, db };
}

// Start standalone server if executed directly via CLI
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  const port = Number(process.env.PORT) || CONFIG.DEFAULT_PORT;
  const dbPath = process.env.DB_PATH || CONFIG.DEFAULT_DB_PATH;
  const { app } = createServer(dbPath);

  const server = app.listen(port, CONFIG.DEFAULT_HOST, () => {
    console.log(`================================================================`);
    console.log(`[CORE_SERVER] Running on http://${CONFIG.DEFAULT_HOST}:${port}`);
    console.log(`[SCHEMA] ${SCHEMA_VERSION}`);
    console.log(`[HONESTY] Model: ${CONFIG.DELIVERY_MODEL}`);
    console.log(`[DB] Storing state at: ${dbPath}`);
    console.log(`================================================================`);
  });

  // Handle graceful termination
  process.on("SIGTERM", () => {
    console.log("[CORE_SERVER] SIGTERM received. Shutting down.");
    server.close(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    console.log("[CORE_SERVER] SIGINT received. Shutting down.");
    server.close(() => process.exit(0));
  });
}
