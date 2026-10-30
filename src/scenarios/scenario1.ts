import { AdapterAMcpClient } from "../adapters/adapterA.js";

/**
 * Scenario 1: Disconnect before ACK, then retry.
 *
 * Sequence:
 * 1. Adapter A submits a new task (SUBMITTED).
 * 2. Fault injector is armed with DROP_BEFORE_ACK.
 * 3. Adapter A sends ACK request; transport drops before the engine records/ACKs the request.
 * 4. Adapter A catches transport failure and retries using the SAME request_id.
 * 5. Retry succeeds.
 *
 * Assertions:
 * - Exactly 1 side effect executed for the ACK request.
 * - Final state is ACKED.
 */
export async function runScenario1(baseUrl: string = "http://127.0.0.1:4200"): Promise<{
  success: boolean;
  dialogId: string;
  taskId: string;
  sideEffectsCount: number;
  details: string;
}> {
  console.log("\n================================================================================");
  console.log(">>> RUNNING SCENARIO 1: Disconnect before ACK, then retry");
  console.log("================================================================================");

  const client = new AdapterAMcpClient(baseUrl);
  const dialogId = `dlg-scen1-${Date.now()}`;
  const taskId = `tsk-scen1-${Date.now()}`;

  // Step 1: Submit task
  console.log(`[SCENARIO_1] Step 1: Submitting new dialog via Adapter A (MCP)...`);
  const submitRes = await client.send({
    jsonrpc: "2.0",
    id: "req-scen1-submit",
    method: "dialog/submit",
    params: {
      dialog_id: dialogId,
      task_id: taskId,
      seq: 0,
      arguments: { title: "Analyze financial dataset" }
    }
  });

  if (submitRes.error) {
    throw new Error(`Scenario 1 failed at submit: ${submitRes.error.message}`);
  }
  console.log(`[SCENARIO_1] Submit succeeded. Current state: ${submitRes.result?.state}`);

  // Step 2: Arm fault injector for DROP_BEFORE_ACK
  console.log(`[SCENARIO_1] Step 2: Arming fault injector with DROP_BEFORE_ACK...`);
  await fetch(`${baseUrl}/api/fault/configure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dropBeforeAck: true })
  });

  // Step 3: Attempt ACK request - transport disconnect expected
  console.log(`[SCENARIO_1] Step 3: Sending ACK request (req-scen1-ack). Expecting transport drop...`);
  let caughtError: any = null;
  try {
    await client.send({
      jsonrpc: "2.0",
      id: "req-scen1-ack",
      method: "dialog/ack",
      params: {
        dialog_id: dialogId,
        task_id: taskId,
        seq: 1,
        arguments: { ack_note: "Initial worker acknowledgement" }
      }
    });
  } catch (err: any) {
    caughtError = err;
    console.log(`[SCENARIO_1] Observed expected transport drop before ACK: ${err.message || err.code}`);
  }

  if (!caughtError) {
    throw new Error("Scenario 1 failed: Expected transport drop before ACK, but request succeeded!");
  }

  // Step 4: Sender retries with the SAME request_id
  console.log(`[SCENARIO_1] Step 4: Retrying ACK request with the exact same request_id (req-scen1-ack)...`);
  const retryRes = await client.send({
    jsonrpc: "2.0",
    id: "req-scen1-ack",
    method: "dialog/ack",
    params: {
      dialog_id: dialogId,
      task_id: taskId,
      seq: 1,
      arguments: { ack_note: "Initial worker acknowledgement" }
    }
  });

  if (retryRes.error) {
    throw new Error(`Scenario 1 retry failed: ${retryRes.error.message}`);
  }
  console.log(`[SCENARIO_1] Retry succeeded. Final state: ${retryRes.result?.state}`);

  // Step 5: Verification via diagnostic inspection
  const effectsRes = await fetch(`${baseUrl}/api/dialog/${dialogId}/effects`);
  const effectsData = (await effectsRes.json()) as { count: number; effects: any[] };

  const ackEffects = effectsData.effects.filter((e) => e.request_id === "req-scen1-ack");

  console.log(`[SCENARIO_1] Assertions check:`);
  console.log(` - Total side effects for dialog: ${effectsData.count}`);
  console.log(` - Side effects for 'req-scen1-ack': ${ackEffects.length} (Expected: 1)`);
  console.log(` - Dialog state: ${retryRes.result?.state} (Expected: ACKED)`);

  const passed = ackEffects.length === 1 && retryRes.result?.state === "ACKED";
  return {
    success: passed,
    dialogId,
    taskId,
    sideEffectsCount: ackEffects.length,
    details: `Retry succeeded, state=ACKED, exactly 1 side effect for req-scen1-ack`
  };
}
