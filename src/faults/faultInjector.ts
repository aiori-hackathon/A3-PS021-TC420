/**
 * Fault injector for simulating network failures and process crashes.
 * Supports:
 * 1. DROP_BEFORE_ACK: simulate network loss before request is acknowledged
 * 2. DROP_AFTER_COMMIT: simulate response loss after SQLite transaction is durably committed
 * 3. CRASH_MID_WORKING: terminate the engine process to test restart recovery
 */

export interface FaultConfig {
  dropBeforeAck?: boolean;
  dropAfterCommit?: boolean;
  crashMidWorking?: boolean;
}

class FaultInjector {
  private config: FaultConfig = {};

  public setFaults(config: FaultConfig): void {
    this.config = { ...this.config, ...config };
    console.log(`[FAULT_INJECTOR] Active faults updated:`, JSON.stringify(this.config));
  }

  public reset(): void {
    this.config = {};
    console.log(`[FAULT_INJECTOR] Faults reset to normal.`);
  }

  public shouldDropBeforeAck(): boolean {
    if (this.config.dropBeforeAck) {
      console.warn(`[FAULT_INJECTOR] Triggering DROP_BEFORE_ACK. Simulating transport drop before commit.`);
      // Clear flag once triggered (one-shot)
      this.config.dropBeforeAck = false;
      return true;
    }
    return false;
  }

  public shouldDropAfterCommit(): boolean {
    if (this.config.dropAfterCommit) {
      console.warn(`[FAULT_INJECTOR] Triggering DROP_AFTER_COMMIT. Transaction committed, killing response path.`);
      // Clear flag once triggered (one-shot)
      this.config.dropAfterCommit = false;
      return true;
    }
    return false;
  }

  public shouldCrashMidWorking(): boolean {
    if (this.config.crashMidWorking) {
      console.warn(`[FAULT_INJECTOR] Triggering CRASH_MID_WORKING. Terminating process immediately.`);
      this.config.crashMidWorking = false;
      return true;
    }
    return false;
  }

  public getConfig(): FaultConfig {
    return { ...this.config };
  }
}

export const faultInjector = new FaultInjector();
