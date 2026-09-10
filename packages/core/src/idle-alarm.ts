// The throttled idle-alarm policy shared by the caller-hosted `Sandbox`
// Durable Object (`sandbox.ts`) and the interpreter Durable Object
// (`InterpreterServer`, packages/interpreter/src/server.ts) -- see
// docs/snapshot-cost-design.md, "Alarm policy". Both sides re-arm a Durable Object alarm after every request that
// touches them, and wipe themselves when it fires without having been
// touched again in the meantime; this class is the mechanics of that,
// independent of what "wipe" or "touched" mean for either caller.

/** The subset of `DurableObjectStorageLike` this policy needs. */
export interface IdleAlarmStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/** Unset/invalid/negative falls back to `defaultMs`; `"0"` (or `0`) disables expiry. */
export function parseIdleTtlMs(raw: unknown, defaultMs: number): number {
  if (raw === undefined || raw === null || raw === "") return defaultMs;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : defaultMs;
}

export const DEFAULT_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Throttled idle-alarm policy: re-arms a Durable Object alarm on `touch()`
 * (called after every request that should keep the owner alive) and answers
 * whether the owner should be destroyed on `onAlarm()` (called from the
 * Durable Object's own `alarm()` handler). `ttlMs` is parsed up front (see
 * `parseIdleTtlMs`) -- this class doesn't re-read env on every call.
 */
export class IdleAlarm {
  /**
   * In-memory cache of the deadline actually armed, lost on eviction;
   * `storage.getAlarm()` (a read, effectively free) is the fallback so the
   * throttling decision below is still correct after a cold start.
   */
  private alarmAt: number | null = null;

  constructor(
    private readonly storage: IdleAlarmStorage,
    private readonly ttlMs: number,
  ) {}

  /**
   * Called after every request that touches the owner. Returns the armed
   * `expiresAt` deadline, or null when expiry is disabled (`ttlMs === 0`),
   * in which case any previously armed alarm is cleared.
   *
   * docs/snapshot-cost-design.md decision 3: re-arming the alarm and
   * recording "last touched" are each their own row write (`setAlarm` and,
   * on the caller's side, an UPDATE via ON CONFLICT DO UPDATE both count 1),
   * so both are throttled to only happen when the new deadline (`want`) is
   * more than `TTL / 10` later than the deadline actually armed right now --
   * the owner may then be destroyed after as little as 0.9 x TTL of
   * inactivity instead of exactly TTL, which is documented. `onRearm` is
   * called with the current time (ISO) only on the branch that actually
   * re-arms, so the caller can write its own "last touched" timestamp in
   * lockstep with the alarm -- never on the branch that leaves the alarm
   * alone.
   *
   * Deviation from the design doc's pseudocode: it returns `armed ?? want`,
   * which -- once any alarm has ever been armed -- returns the stale
   * `armed` value even on a call that just re-armed to `want` (`??` only
   * falls through when the left side is null/undefined, and `armed` isn't
   * once one exists). That would make `expiresAt` stop advancing after the
   * first arm. Returning `want` on the branch that actually re-arms (and
   * `armed` otherwise) is the fix that matches the doc's own comment ("the
   * deadline actually armed").
   */
  async touch(onRearm: (nowIso: string) => void): Promise<number | null> {
    if (this.ttlMs === 0) {
      const armed = this.alarmAt ?? (await this.storage.getAlarm());
      if (armed != null) await this.storage.deleteAlarm();
      this.alarmAt = null;
      return null;
    }
    const now = Date.now();
    const armed = this.alarmAt ?? (await this.storage.getAlarm());
    this.alarmAt = armed; // cache a cold-start storage.getAlarm() read even if we don't rearm below
    const want = now + this.ttlMs;
    if (armed == null || want - armed > this.ttlMs / 10) {
      await this.storage.setAlarm(want);
      this.alarmAt = want;
      onRearm(new Date(now).toISOString());
      return want; // the deadline actually armed
    }
    return armed; // unchanged: still the deadline actually armed
  }

  /**
   * The alarm-handler side: fires at whatever deadline was last armed.
   * Because the alarm is throttled (see `touch` above), that deadline can be
   * stale by up to `TTL / 10` -- so before the caller destroys anything, this
   * re-checks the real deadline computed from the persisted `lastUsedIso`
   * and, if activity since the last arm pushed it into the future, re-arms
   * to that time instead of expiring early (docs/snapshot-cost-design.md,
   * "Alarm policy"). Returns `"disabled"` when expiry is off (`ttlMs === 0`,
   * a no-op: the caller does nothing), `"rearmed"` when it re-armed instead
   * of expiring, or `"destroy"` when the caller should wipe itself.
   */
  async onAlarm(lastUsedIso: string): Promise<"destroy" | "rearmed" | "disabled"> {
    if (this.ttlMs === 0) return "disabled";
    const deadline = Date.parse(lastUsedIso) + this.ttlMs;
    if (deadline > Date.now()) {
      await this.storage.setAlarm(deadline);
      this.alarmAt = deadline;
      return "rearmed";
    }
    return "destroy";
  }

  /** Clears the in-memory deadline cache -- call after `storage.deleteAll()`/destroying the owner. */
  reset(): void {
    this.alarmAt = null;
  }
}
