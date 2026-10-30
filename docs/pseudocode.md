# Atomic Dialog Deduplication & State Transition Algorithm

## Specification Reference: Section 7 (`engine.handle(envelope)`)

The following pseudocode defines the atomic execution flow executed within a single SQLite transaction (`BEGIN IMMEDIATE`). This guarantees that side effects, state mutations, and request receipts commit atomically or not at all.

```text
FUNCTION handle(envelope):
    ASSERT envelope.schema_version == "EXPERIMENTAL DRAFT v0, schema version pending mentor pinning"
    
    payload_hash = SHA256(canonical_json(envelope.payload))
    now = CURRENT_TIMESTAMP()

    IF fault_injector.should_drop_before_ack():
        RAISE NetworkDisconnectException("Simulated transport loss before processing")

    BEGIN IMMEDIATE TRANSACTION

    TRY:
        // 1. Check idempotency log
        existing_req = SELECT payload_hash, response_json, attempts 
                       FROM requests 
                       WHERE dialog_id = envelope.dialog_id 
                         AND request_id = envelope.request_id

        IF existing_req EXISTS:
            // 2. Duplicate Detection Path
            IF existing_req.payload_hash == payload_hash:
                UPDATE requests 
                SET attempts = attempts + 1 
                WHERE dialog_id = envelope.dialog_id AND request_id = envelope.request_id
                
                COMMIT TRANSACTION
                
                cached_res = PARSE_JSON(existing_req.response_json)
                RETURN cached_res WITH {
                    attempts: existing_req.attempts + 1,
                    is_duplicate: TRUE,
                    effect_executed: FALSE
                }
            ELSE:
                // 3. Request ID Conflict Path (same ID, mutated content)
                ROLLBACK TRANSACTION
                RETURN Error("REQUEST_ID_CONFLICT", 
                             "Request ID already processed with different payload")

        // 4. New Request Path: State Machine Evaluation
        existing_dialog = SELECT state, seq, task_id 
                          FROM dialogs 
                          WHERE dialog_id = envelope.dialog_id

        current_state = existing_dialog ? existing_dialog.state : "CREATED"
        target_state = MAP_ACTION_TO_STATE(envelope.action)

        // Correlate dialog_id with stable task_id
        IF existing_dialog AND existing_dialog.task_id != envelope.task_id:
            ROLLBACK TRANSACTION
            RETURN Error("INTERNAL_ERROR", "Task ID mismatch for existing dialog")

        // Validate state transition
        IF NOT IS_VALID_TRANSITION(current_state, target_state):
            ROLLBACK TRANSACTION
            RETURN Error("ILLEGAL_TRANSITION", 
                         "Invalid transition from " + current_state + " to " + target_state)

        // 5. Legal Transition: Update Dialog State First (Satisfies Foreign Key)
        IF NOT existing_dialog:
            new_seq = 1
            INSERT INTO dialogs (dialog_id, task_id, state, seq, origin_adapter, schema_version, created_at, updated_at)
            VALUES (envelope.dialog_id, envelope.task_id, target_state, new_seq, envelope.origin_adapter, SCHEMA_VERSION, now, now)
        ELSE:
            new_seq = existing_dialog.seq + 1
            UPDATE dialogs 
            SET state = target_state, seq = new_seq, updated_at = now 
            WHERE dialog_id = envelope.dialog_id

        // Execute Mock External Side Effect
        effect_type = "EXECUTE_ACTION_" + envelope.action
        effect_data = JSON_ENCODE({ action: envelope.action, payload: envelope.payload, executed_at: now })
        
        INSERT INTO side_effects (dialog_id, request_id, effect_type, effect_data, created_at)
        VALUES (envelope.dialog_id, envelope.request_id, effect_type, effect_data, now)

        response_data = {
            success: TRUE,
            dialog_id: envelope.dialog_id,
            task_id: envelope.task_id,
            state: target_state,
            seq: new_seq,
            attempts: 1,
            is_duplicate: FALSE,
            effect_executed: TRUE,
            data: { action: envelope.action, executed_effect: effect_type, timestamp: now }
        }

        // Record request into idempotency store
        INSERT INTO requests (dialog_id, request_id, payload_hash, response_json, attempts, first_seen_at)
        VALUES (envelope.dialog_id, envelope.request_id, payload_hash, JSON_ENCODE(response_data), 1, now)

        // Atomic commit to disk
        COMMIT TRANSACTION

        // Post-commit fault hooks
        IF envelope.action == "START_WORK" AND fault_injector.should_crash_mid_working():
            ABRUPT_EXIT_PROCESS()

        IF fault_injector.should_drop_after_commit():
            CLOSE_NETWORK_SOCKET_WITHOUT_RESPONSE()

        RETURN response_data

    CATCH Exception ex:
        ROLLBACK TRANSACTION
        RETHROW ex
```

## Guarantees & Correctness Analysis
1. **Crash before COMMIT**: No rows in `dialogs`, `requests`, or `side_effects`. The state rollback leaves zero partial side effects.
2. **Crash after COMMIT**: SQLite WAL mode ensures all three tables (`dialogs`, `requests`, `side_effects`) persist synchronously. A subsequent client retry with the same `(dialog_id, request_id)` enters step 2 (duplicate path), skips side effect execution, and returns the cached response.
3. **Foreign Key Integrity**: `dialogs` is upserted prior to `side_effects` and `requests` insertions, ensuring strict SQLite foreign key constraint compliance under `PRAGMA foreign_keys = ON;`.
