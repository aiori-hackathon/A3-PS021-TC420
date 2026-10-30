import { AdapterAMcpClient } from "../adapters/adapterA.js";

/**
 * Scenario 4: Same request_id, different payload.
 *
 * Sequence:
 * 1. Adapter A submits an initial request with request_id = 'req-conflict-test' and payload A.
 * 2. Request succeeds and records side effect.
 * 3. Client retransmits the same request_id = 'req-conflict-test' but with a mutated payload B.
 * 4. Engine detects hash mismatch and rejects the request with REQUEST_ID_CONFLICT.
 *
 * Assertions:
 * - Error code is strictly REQUEST_ID_CONFLICT.
 * - No new side effect is inserted into side_effects table.
 */
export async function runScenario4(baseUrl: string = "http://127.0.0.1:4200"): Promise<{
  success: boolean;
  dialogId: string;
  taskId: string;
  errorCode: string;
  sideEffectsCount: number;
  details: string;
}> {
  console.log("\n================================================================================");
  console.log(">>> RUNNING SCENARIO 4: Same request_id, different payload (REQUEST_ID_CONFLICT)");
  console.log("================================================================================");

  const client = new AdapterAMcpClient(baseUrl);
  const dialogId = `dlg-scen4-${Date.now()}`;
  const taskId = `tsk-scen4-${Date.now()}`;
  const duplicateRequestId = "req-conflict-test-01";

  // Step 1: Submit initial request with payload A
  console.log(`[SCENARIO_4] Step 1: Submitting initial request with payload A...`);
  const initialRes = await client.send({
    jsonrpc: "2.0",
    id: duplicateRequestId,
    method: "dialog/submit",
    params: {
      dialog_id: dialogId,
      task_id: taskId,
      seq: 0,
      arguments: { operation: "database_export", format: "parquet" }
    }
  });

  if (initialRes.error) {
    throw new Error(`Scenario 4 initial request failed: ${initialRes.error.message}`);
  }
  console.log(`[SCENARIO_4] Initial request succeeded. State: ${initialRes.result?.state}`);

  // Inspect side effects count after Step 1
  const effectsBefore = await (await fetch(`${baseUrl}/api/dialog/${dialogId}/effects`)).json();
  const countBefore = effectsBefore.count;
  console.log(`[SCENARIO_4] Side effects count after initial request: ${countBefore}`);

  // Step 2: Send conflicting request with SAME request_id but mutated payload B
  console.log(`[SCENARIO_4] Step 2: Transmitting same request_id with mutated payload B...`);
  const conflictRes = await client.send({
    jsonrpc: "2.0",
    id: duplicateRequestId,
    method: "dialog/submit",
    params: {
      dialog_id: dialogId,
      task_id: taskId,
      seq: 0,
      arguments: { operation: "database_export", format: "csv_mutated_payload" } // Different payload!
    }
  });

  console.log(`[SCENARIO_4] Conflict response received:`, conflictRes);

  const errorCode = (conflictRes.error?.data as any)?.error || conflictRes.error?.message;
  console.log(`[SCENARIO_4] Observed error code: ${errorCode}`);

  // Step 3: Inspect side effects count after conflict
  const effectsAfter = await (await fetch(`${baseUrl}/api/dialog/${dialogId}/effects`)).json();
  const countAfter = effectsAfter.count;
  console.log(`[SCENARIO_4] Side effects count after conflict attempt: ${countAfter}`);

  // Assertions:
  // 1. Error is REQUEST_ID_CONFLICT
  // 2. Count did not increase (countAfter === countBefore)
  const isConflictError = errorCode === "REQUEST_ID_CONFLICT";
  const noNewSideEffects = countAfter === countBefore;
  const passed = isConflictError && noNewSideEffects;

  console.log(`[SCENARIO_4] Assertions check:`);
  console.log(` - Error matches REQUEST_ID_CONFLICT: ${isConflictError}`);
  console.log(` - Side effects count unchanged (${countBefore} -> ${countAfter}): ${noNewSideEffects}`);
  console.log(` - Scenario 4 Result: ${passed ? "PASSED" : "FAILED"}`);

  return {
    success: passed,
    dialogId,
    taskId,
    errorCode: String(errorCode),
    sideEffectsCount: countAfter,
    details: `Rejected with REQUEST_ID_CONFLICT, 0 new side effects executed`
  };
}
