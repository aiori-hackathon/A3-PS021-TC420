import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Creates and initializes a synchronous SQLite connection with WAL mode and foreign keys enabled.
 */
export function createDatabase(dbPath: string = CONFIG.DEFAULT_DB_PATH): DatabaseSync {
  // Ensure directory exists if path is specified
  if (dbPath !== ":memory:") {
    const dir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);

  // Critical SQLite Pragmas for durability and data integrity
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");

  // Read and execute schema definition
  const schemaPath = path.join(__dirname, "schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf-8");
  db.exec(schemaSql);

  return db;
}

export type DatabaseInstance = DatabaseSync;
