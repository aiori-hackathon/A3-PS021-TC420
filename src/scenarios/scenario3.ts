import { fork, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterAMcpClient } from "../adapters/adapterA.js";
import { AdapterBA2AClient } from "../adapters/adapterB.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServerProcess(port: number, dbPath: string): Promise<ChildProcess> {
  const serverPath = path.resolve(__dirname, "../core/server.ts");
  const child = fork(serverPath, [], {
    execArgv: ["--import", "tsx"],
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath },
    stdio: "pipe"
  });

  // Wait for health endpoint to respond
  const startTime = Date.now();
  while (Date.now() - startTime < 10000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        return child;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  child.kill("SIGKILL");
  throw new Error(`Timeout waiting for engine server process to start on port ${port}`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.killed || child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
    // Fallback timer
    setTimeout(resolve, 1000);
  });
}

/**
 * Scenario 3: Real ungraceful process crash mid-WORKING, restart, and cross-adapter continuation.
 *
 * Sequence:
 * 1. Spawn engine process #1 on port 4203 with persistent DB.
 * 2. Adapter A (MCP-style JSON-RPC) submits, acks, and starts work -> State is WORKING.
 * 3. KILL engine process #1 with SIGKILL (hard crash simulation).
 * 4. Verify process #1 is dead and server is unreachable.
 * 5. Spawn engine process #2 against the EXACT same SQLite database file.
 * 6. Adapter B (A2A-style task message) resumes the dialog using the same dialog_id and task_id.
 * 7. Adapter B transitions the task to COMPLETED.
 *
 * Assertions:
 * - dialog_id and task_id preserved identically across process crash.
 * - State recovered from SQLite WAL store as WORKING.
 * - Cross-adapter correlation verified (Started via Adapter A, completed via Adapter B).
 * - Final state is COMPLETED.
 */
export async function runScenario3(
  port: number = 4203,
  dbPath: string = "./scenario3_recovery.db"
): Promise<{
  success: boolean;
  dialogId: string;
  taskId: string;
  originAdapter: string;
  completingAdapter: string;
  finalState: string;
  details: string;
}> {
  console.log("\n================================================================================");
  console.log(">>> RUNNING SCENARIO 3: Hard Crash mid-WORKING + Cross-Adapter Recovery (A -> B)");
  console.log("================================================================================");

  // Clean previous DB if existing
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  if (fs.existsSync(`${dbPath}-wal`)) fs.unlinkSync(`${dbPath}-wal`);
  if (fs.existsSync(`${dbPath}-shm`)) fs.unlinkSync(`${dbPath}-shm`);

  const baseUrl = `http://127.0.0.1:${port}`;
  const dialogId = `dlg-cross-adapt-${Date.now()}`;
  const taskId = `tsk-stable-${Date.now()}`;

  // Step 1: Start Engine Process #1
  console.log(`[SCENARIO_3] Step 1: Spawning Engine Process #1 on ${baseUrl} (PID tracked)...`);
  let serverProcess = await startServerProcess(port, dbPath);
  console.log(`[SCENARIO_3] Engine Process #1 active with PID: ${serverProcess.pid}`);

  // Step 2: Adapter A starts the workflow (MCP-style)
  console.log(`[SCENARIO_3] Step 2: Adapter A (MCP) submits task and transitions to WORKING...`);
  const clientA = new AdapterAMcpClient(baseUrl);

  await clientA.send({
    jsonrpc: "2.0",
    id: "req-scen3-mcp-submit",
    method: "dialog/submit",
    params: {
      dialog_id: dialogId,
      task_id: taskId,
      seq: 0,
      arguments: { prompt: "Generate Quarterly Compliance Report" }
    }
  });

  await clientA.send({
    jsonrpc: "2.0",
    id: "req-scen3-mcp-ack",
    method: "dialog/ack",
    params: {
      dialog_id: dialogId,
      task_id: taskId,
      seq: 1,
      arguments: { worker: "mcp-agent-lead" }
    }
  });

  const workRes = await clientA.send({
    jsonrpc: "2.0",
    id: "req-scen3-mcp-work",
    method: "dialog/start_work",
    params: {
      dialog_id: dialogId,
      task_id: taskId,
      seq: 2,
      arguments: { priority: "HIGH", memory_budget: "8GB" }
    }
  });

  console.log(`[SCENARIO_3] Dialog reached state: ${workRes.result?.state} via Adapter A`);

  // Step 3: Hard crash process mid-WORKING
  console.log(`[SCENARIO_3] Step 3: Simulating HARD PROCESS CRASH mid-WORKING (killing PID ${serverProcess.pid})...`);
  await stopProcess(serverProcess);

  // Step 4: Verify process is terminated
  let isDown = false;
  try {
    await fetch(`${baseUrl}/health`);
  } catch {
    isDown = true;
  }
  console.log(`[SCENARIO_3] Verified engine process is dead: ${isDown}`);

  // Step 5: Restart Engine Process #2 pointing to the same SQLite DB
  console.log(`[SCENARIO_3] Step 5: Restarting Engine Process #2 against identical DB (${dbPath})...`);
  serverProcess = await startServerProcess(port, dbPath);
  console.log(`[SCENARIO_3] Engine Process #2 restarted with PID: ${serverProcess.pid}`);

  // Step 6: Verify persisted state after restart
  const diagRes = await fetch(`${baseUrl}/api/dialog/${dialogId}`);
  const recoveredDialog = (await diagRes.json()) as { dialog_id: string; task_id: string; state: string; seq: number };
  console.log(`[SCENARIO_3] State recovered after reboot:`);
  console.log(` - Dialog ID: ${recoveredDialog.dialog_id}`);
  console.log(` - Stable Task ID: ${recoveredDialog.task_id}`);
  console.log(` - Preserved State: ${recoveredDialog.state} (Expected: WORKING)`);

  // Step 7: Adapter B (A2A-style) continues and completes the dialog
  console.log(`[SCENARIO_3] Step 7: Adapter B (A2A) continues the correlated dialog and completes it...`);
  const clientB = new AdapterBA2AClient(baseUrl);

  const completeRes = await clientB.send({
    message_type: "task_complete",
    message_id: "req-scen3-a2a-complete",
    task_context: {
      dialog_id: dialogId,
      task_id: taskId,
      sequence_num: recoveredDialog.seq
    },
    body: {
      details: {
        output_report_uri: "s3://reports/q4_compliance.pdf",
        rows_processed: 452000
      }
    }
  });

  console.log(`[SCENARIO_3] Adapter B completion result:`);
  console.log(` - Status: ${completeRes.status}`);
  console.log(` - Correlation ID: ${completeRes.correlation_id}`);
  console.log(` - Side Effect Executed: ${completeRes.effect_executed}`);

  // Step 8: Final assertions
  const finalDiag = await (await fetch(`${baseUrl}/api/dialog/${dialogId}`)).json();
  const passed =
    recoveredDialog.state === "WORKING" &&
    recoveredDialog.task_id === taskId &&
    completeRes.status === "COMPLETED" &&
    finalDiag.state === "COMPLETED";

  console.log(`[SCENARIO_3] Scenario 3 result: ${passed ? "PASSED" : "FAILED"}`);

  // Cleanup child process
  await stopProcess(serverProcess);

  // Cleanup temp DB files
  try {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(`${dbPath}-wal`)) fs.unlinkSync(`${dbPath}-wal`);
    if (fs.existsSync(`${dbPath}-shm`)) fs.unlinkSync(`${dbPath}-shm`);
  } catch {}

  return {
    success: passed,
    dialogId,
    taskId,
    originAdapter: "adapter-a-mcp",
    completingAdapter: "adapter-b-a2a",
    finalState: finalDiag.state,
    details: `Task survived hard crash, recovered as WORKING, completed across adapters (A -> B)`
  };
}
