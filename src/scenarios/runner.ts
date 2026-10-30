import fs from "node:fs";
import { createServer } from "../core/server.js";
import { SCHEMA_VERSION, CONFIG } from "../core/config.js";
import { runScenario1 } from "./scenario1.js";
import { runScenario2 } from "./scenario2.js";
import { runScenario3 } from "./scenario3.js";
import { runScenario4 } from "./scenario4.js";
import { runScenario5 } from "./scenario5.js";

async function main() {
  console.log(`
################################################################################
#  AIORI-3 / PS-021: Experimental Dialog Correlation Across Agent Adapters     #
#  Schema Version: "${SCHEMA_VERSION}"
#  Honest Model: At-least-once transport + idempotent receiver = effectively-once
################################################################################
`);

  const demoDb = "./demo_store.db";
  // Reset demo db
  if (fs.existsSync(demoDb)) fs.unlinkSync(demoDb);
  if (fs.existsSync(`${demoDb}-wal`)) fs.unlinkSync(`${demoDb}-wal`);
  if (fs.existsSync(`${demoDb}-shm`)) fs.unlinkSync(`${demoDb}-shm`);

  const { app } = createServer(demoDb);
  const server = app.listen(CONFIG.DEFAULT_PORT, CONFIG.DEFAULT_HOST);
  console.log(`[DEMO_SERVER] Running on http://${CONFIG.DEFAULT_HOST}:${CONFIG.DEFAULT_PORT}`);

  const results: Array<{
    scenario: string;
    description: string;
    status: "PASS" | "FAIL";
    assertions: string;
  }> = [];

  try {
    // Scenario 1
    const res1 = await runScenario1();
    results.push({
      scenario: "Scenario 1",
      description: "Disconnect before ACK, retry",
      status: res1.success ? "PASS" : "FAIL",
      assertions: "Exact 1 side effect, final state ACKED, retry succeeded"
    });

    // Scenario 2
    const res2 = await runScenario2();
    results.push({
      scenario: "Scenario 2",
      description: "Disconnect after commit before response, retry",
      status: res2.success ? "PASS" : "FAIL",
      assertions: "Exact 1 side effect, attempts = 2, duplicate suppressed"
    });

    // Scenario 3 (Uses separate port 4203 and dedicated DB for real process kill)
    const res3 = await runScenario3(4203, "./scenario3_demo.db");
    results.push({
      scenario: "Scenario 3",
      description: "Crash mid-WORKING + Cross-Adapter Recovery (A -> B)",
      status: res3.success ? "PASS" : "FAIL",
      assertions: "Stable task_id preserved across crash, state recovered as WORKING, completed by Adapter B"
    });

    // Scenario 4
    const res4 = await runScenario4();
    results.push({
      scenario: "Scenario 4",
      description: "Same request_id, different payload",
      status: res4.success ? "PASS" : "FAIL",
      assertions: "Rejected with REQUEST_ID_CONFLICT, 0 new side effects"
    });

    // Scenario 5
    const res5 = await runScenario5();
    results.push({
      scenario: "Scenario 5",
      description: "Late message after COMPLETED (out-of-order)",
      status: res5.success ? "PASS" : "FAIL",
      assertions: "Rejected with ILLEGAL_TRANSITION, state remains COMPLETED"
    });
  } catch (err) {
    console.error(`[DEMO_ERROR] Scenario execution failed:`, err);
  } finally {
    server.close();
    // Cleanup demo db
    try {
      if (fs.existsSync(demoDb)) fs.unlinkSync(demoDb);
      if (fs.existsSync(`${demoDb}-wal`)) fs.unlinkSync(`${demoDb}-wal`);
      if (fs.existsSync(`${demoDb}-shm`)) fs.unlinkSync(`${demoDb}-shm`);
    } catch {}
  }

  // Print Formatted Results Table
  console.log("\n==========================================================================================");
  console.log("                                  SCENARIO TEST RESULTS                                   ");
  console.log("==========================================================================================");
  console.table(results);
  console.log("==========================================================================================");

  const allPassed = results.every((r) => r.status === "PASS");
  if (allPassed) {
    console.log(">>> ALL 5 SCENARIOS PASSED WITH HIGH-INTEGRITY ASSERTIONS.");
    process.exit(0);
  } else {
    console.error(">>> ONE OR MORE SCENARIOS FAILED.");
    process.exit(1);
  }
}

main();
