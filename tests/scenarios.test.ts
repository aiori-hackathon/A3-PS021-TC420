import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "../src/core/server.js";
import { runScenario1 } from "../src/scenarios/scenario1.js";
import { runScenario2 } from "../src/scenarios/scenario2.js";
import { runScenario3 } from "../src/scenarios/scenario3.js";
import { runScenario4 } from "../src/scenarios/scenario4.js";
import { runScenario5 } from "../src/scenarios/scenario5.js";

const TEST_PORT = 4250;
const TEST_DB = "./test_suite.db";

describe("PS-021: Dialog Correlation and Recovery Across Agent Adapters", () => {
  let serverInstance: any;

  before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(`${TEST_DB}-wal`)) fs.unlinkSync(`${TEST_DB}-wal`);
    if (fs.existsSync(`${TEST_DB}-shm`)) fs.unlinkSync(`${TEST_DB}-shm`);

    const { app } = createServer(TEST_DB);
    serverInstance = app.listen(TEST_PORT, "127.0.0.1");
    // Ensure server is up
    await new Promise((r) => setTimeout(r, 300));
  });

  after(() => {
    if (serverInstance) serverInstance.close();
    try {
      if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
      if (fs.existsSync(`${TEST_DB}-wal`)) fs.unlinkSync(`${TEST_DB}-wal`);
      if (fs.existsSync(`${TEST_DB}-shm`)) fs.unlinkSync(`${TEST_DB}-shm`);
    } catch {}
  });

  it("Scenario 1: Disconnect before ACK, then retry (exact 1 side effect)", async () => {
    const res = await runScenario1(`http://127.0.0.1:${TEST_PORT}`);
    assert.equal(res.success, true, "Scenario 1 must pass");
    assert.equal(res.sideEffectsCount, 1, "Exactly 1 side effect must exist for the ACK request");
  });

  it("Scenario 2: Disconnect after commit but before response (exact 1 side effect, attempts = 2)", async () => {
    const res = await runScenario2(`http://127.0.0.1:${TEST_PORT}`);
    assert.equal(res.success, true, "Scenario 2 must pass");
    assert.equal(res.sideEffectsCount, 1, "Exactly 1 side effect must exist for the WORK request");
    assert.equal(res.attempts, 2, "Attempts count must equal 2 after retry");
  });

  it("Scenario 3: Crash mid-WORKING and Cross-Adapter continuation (Adapter A -> B)", async () => {
    // Uses separate dedicated port 4253 and DB to test child process kill
    const res = await runScenario3(4253, "./test_scenario3.db");
    assert.equal(res.success, true, "Scenario 3 must pass");
    assert.equal(res.originAdapter, "adapter-a-mcp");
    assert.equal(res.completingAdapter, "adapter-b-a2a");
    assert.equal(res.finalState, "COMPLETED");
  });

  it("Scenario 4: Same request_id, different payload (REQUEST_ID_CONFLICT, 0 new side effects)", async () => {
    const res = await runScenario4(`http://127.0.0.1:${TEST_PORT}`);
    assert.equal(res.success, true, "Scenario 4 must pass");
    assert.equal(res.errorCode, "REQUEST_ID_CONFLICT");
  });

  it("Scenario 5: Late message after COMPLETED (ILLEGAL_TRANSITION, state remains COMPLETED)", async () => {
    const res = await runScenario5(`http://127.0.0.1:${TEST_PORT}`);
    assert.equal(res.success, true, "Scenario 5 must pass");
    assert.equal(res.errorCode, "ILLEGAL_TRANSITION");
    assert.equal(res.currentState, "COMPLETED");
  });
});
