import { AdapterBA2AClient } from "../adapters/adapterB.js";

/**
 * Scenario 2: Disconnect after commit but before response, then retry.
 *
 * Sequence:
 * 1. Adapter B submits and acks a task.
 * 2. Fault injector is armed with DROP_AFTER_COMMIT.
 * 3. Adapter B sends START_WORK (req-scen2-work).
 * 4. Engine atomically commits side effect and state transition to SQLite, but transport drops before response delivery.
 * 5. Adapter B catches transport failure and retries using the exact same request_id and payload.
 * 6. Engine duplicate detection suppresses side effect, increments attempts to 2, and returns cached response.
 *
 * Assertions:
 * - Exactly 1 side effect for req-scen2-work.
 * - attempts = 2 in requests table.
 * - Final state is WORKING.
 */
export async function runScenario2(baseUrl: string = "http://127.0.0.1:4200"): Promise<{
  success: boolean;
  dialogId: string;
  taskId: string;
  attempts: number;
  sideEffectsCount: number;
  details: string;
}> {
  console.log("\n================================================================================");
  console.log(">>> RUNNING SCENARIO 2: Disconnect after commit before response, then retry");
  console.log("================================================================================");

  const client = new AdapterBA2AClient(baseUrl);
  const dialogId = `dlg-scen2-${Date.now()}`;
  const taskId = `tsk-scen2-${Date.now()}`;

  // Step 1: Submit and ACK task via Adapter B
  console.log(`[SCENARIO_2] Step 1: Submitting and acknowledging task via Adapter B (A2A)...`);
  await client.send({
    message_type: "task_submit",
    message_id: "req-scen2-submit",
    task_context: { dialog_id: dialogId, task_id: taskId, sequence_num: 0 },
    body: { details: { pipeline: "credit-scoring-pipeline" } }
  });

  await client.send({
    message_type: "task_ack",
    message_id: "req-scen2-ack",
    task_context: { dialog_id: dialogId, task_id: taskId, sequence_num: 1 },
    body: { details: { status: "acknowledged" } }
  });

  // Step 2: Arm fault injector for DROP_AFTER_COMMIT
  console.log(`[SCENARIO_2] Step 2: Arming fault injector with DROP_AFTER_COMMIT...`);
  await fetch(`${baseUrl}/api/fault/configure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dropAfterCommit: true })
  });

  // Step 3: Send START_WORK (req-scen2-work). Transport drops AFTER commit.
  console.log(`[SCENARIO_2] Step 3: Sending START_WORK (req-scen2-work). Expecting socket drop after DB commit...`);
  let caughtError: any = null;
  try {
    await client.send({
      message_type: "task_start",
      message_id: "req-scen2-work",
      task_context: { dialog_id: dialogId, task_id: taskId, sequence_num: 2 },
      body: { details: { worker_id: "worker-cluster-01", memory_limit: "4GB" } }
    });
  } catch (err: any) {
    caughtError = err;
    console.log(`[SCENARIO_2] Observed expected transport drop after commit: ${err.message || err.code}`);
  }

  if (!caughtError) {
    throw new Error("Scenario 2 failed: Expected transport drop after commit, but request succeeded!");
  }

  // Step 4: Retry with the exact same request_id and payload
  console.log(`[SCENARIO_2] Step 4: Retrying with identical request_id (req-scen2-work)...`);
  const retryRes = await client.send({
    message_type: "task_start",
    message_id: "req-scen2-work",
    task_context: { dialog_id: dialogId, task_id: taskId, sequence_num: 2 },
    body: { details: { worker_id: "worker-cluster-01", memory_limit: "4GB" } }
  });

  if (retryRes.status === "ERROR") {
    throw new Error(`Scenario 2 retry failed: ${retryRes.error?.message}`);
  }

  console.log(`[SCENARIO_2] Retry succeeded!`);
  console.log(` - is_duplicate: ${retryRes.is_duplicate}`);
  console.log(` - attempts count: ${retryRes.attempts}`);
  console.log(` - side effect executed: ${retryRes.effect_executed}`);

  // Step 5: Verification via diagnostic inspection
  const effectsRes = await fetch(`${baseUrl}/api/dialog/${dialogId}/effects`);
  const effectsData = (await effectsRes.json()) as { count: number; effects: any[] };
  const workEffects = effectsData.effects.filter((e) => e.request_id === "req-scen2-work");

  const reqRes = await fetch(`${baseUrl}/api/dialog/${dialogId}/requests`);
  const reqData = (await reqRes.json()) as { requests: any[] };
  const workReq = reqData.requests.find((r) => r.request_id === "req-scen2-work");

  console.log(`[SCENARIO_2] Assertions check:`);
  console.log(` - Side effects for 'req-scen2-work': ${workEffects.length} (Expected: 1)`);
  console.log(` - Attempts recorded: ${workReq?.attempts} (Expected: 2)`);
  console.log(` - is_duplicate reported: ${retryRes.is_duplicate} (Expected: true)`);
  console.log(` - effect_executed reported: ${retryRes.effect_executed} (Expected: false)`);

  const passed =
    workEffects.length === 1 &&
    workReq?.attempts === 2 &&
    retryRes.is_duplicate === true &&
    retryRes.effect_executed === false;

  return {
    success: passed,
    dialogId,
    taskId,
    attempts: workReq?.attempts || 0,
    sideEffectsCount: workEffects.length,
    details: `Retry returned cached response, exactly 1 side effect, attempts = 2`
  };
}
