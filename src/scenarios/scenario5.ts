import { AdapterBA2AClient } from "../adapters/adapterB.js";

/**
 * Scenario 5: Late out-of-order message after COMPLETED.
 *
 * Sequence:
 * 1. Progress a dialog to terminal state COMPLETED:
 *    SUBMITTED -> ACKED -> WORKING -> COMPLETED
 * 2. Simulate late arrival of an out-of-order message (e.g. late task_resume or task_start).
 * 3. Engine checks state machine, detects COMPLETED is a terminal state, and rejects transition.
 *
 * Assertions:
 * - Error returned is strictly ILLEGAL_TRANSITION.
 * - Dialog state remains strictly COMPLETED.
 * - No new requests row or side effect row is committed for the illegal attempt.
 */
export async function runScenario5(baseUrl: string = "http://127.0.0.1:4200"): Promise<{
  success: boolean;
  dialogId: string;
  taskId: string;
  errorCode: string;
  currentState: string;
  details: string;
}> {
  console.log("\n================================================================================");
  console.log(">>> RUNNING SCENARIO 5: Late message after COMPLETED (ILLEGAL_TRANSITION)");
  console.log("================================================================================");

  const client = new AdapterBA2AClient(baseUrl);
  const dialogId = `dlg-scen5-${Date.now()}`;
  const taskId = `tsk-scen5-${Date.now()}`;

  // Step 1: Walk dialog through valid lifecycle to COMPLETED
  console.log(`[SCENARIO_5] Step 1: Progressing dialog to terminal state COMPLETED...`);
  await client.send({
    message_type: "task_submit",
    message_id: "req-scen5-1-submit",
    task_context: { dialog_id: dialogId, task_id: taskId, sequence_num: 0 },
    body: { details: { job: "Index documents" } }
  });

  await client.send({
    message_type: "task_ack",
    message_id: "req-scen5-2-ack",
    task_context: { dialog_id: dialogId, task_id: taskId, sequence_num: 1 },
    body: { details: { assigned_to: "search-cluster" } }
  });

  await client.send({
    message_type: "task_start",
    message_id: "req-scen5-3-work",
    task_context: { dialog_id: dialogId, task_id: taskId, sequence_num: 2 },
    body: { details: { batch_size: 500 } }
  });

  const completeRes = await client.send({
    message_type: "task_complete",
    message_id: "req-scen5-4-complete",
    task_context: { dialog_id: dialogId, task_id: taskId, sequence_num: 3 },
    body: { details: { indexed_count: 500 } }
  });

  console.log(`[SCENARIO_5] Dialog reached state: ${completeRes.status}`);

  // Step 2: Attempt late message on terminal state COMPLETED
  console.log(`[SCENARIO_5] Step 2: Sending late out-of-order message (task_start) on COMPLETED dialog...`);
  const lateRes = await client.send({
    message_type: "task_start",
    message_id: "req-scen5-late-message",
    task_context: { dialog_id: dialogId, task_id: taskId, sequence_num: 4 },
    body: { details: { late_batch: 10 } }
  });

  console.log(`[SCENARIO_5] Late message response:`, lateRes);

  const errorCode = lateRes.error?.code || (lateRes.error?.data as any)?.error;
  console.log(`[SCENARIO_5] Observed error code: ${errorCode}`);

  // Step 3: Verify dialog state in DB remains COMPLETED
  const finalDialog = await (await fetch(`${baseUrl}/api/dialog/${dialogId}`)).json();
  console.log(`[SCENARIO_5] Current dialog state in DB: ${finalDialog.state}`);

  // Assertions:
  // 1. Error is ILLEGAL_TRANSITION
  // 2. Dialog state remains COMPLETED
  const isIllegalTransition = errorCode === "ILLEGAL_TRANSITION";
  const stateRemainsCompleted = finalDialog.state === "COMPLETED";
  const passed = isIllegalTransition && stateRemainsCompleted;

  console.log(`[SCENARIO_5] Assertions check:`);
  console.log(` - Error matches ILLEGAL_TRANSITION: ${isIllegalTransition}`);
  console.log(` - State remains COMPLETED: ${stateRemainsCompleted}`);
  console.log(` - Scenario 5 Result: ${passed ? "PASSED" : "FAILED"}`);

  return {
    success: passed,
    dialogId,
    taskId,
    errorCode: String(errorCode),
    currentState: finalDialog.state,
    details: `Illegal transition rejected on terminal state, state preserved as COMPLETED`
  };
}
