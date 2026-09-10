// Pure Node tests for `IdleAlarm` (packages/core/src/idle-alarm.ts), the
// throttled idle-alarm policy shared by the caller-hosted `Sandbox` Durable
// Object (sandbox.ts) and the interpreter Durable Object
// (runtime/interpreter.mjs) -- see docs/snapshot-cost-design.md, "Alarm
// policy". Run `pnpm --filter @sandbox-workers/core build` first; this
// imports the built package, not the TypeScript source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IdleAlarm } from "../packages/core/dist/index.js";

/** A fake `IdleAlarmStorage` that records every call. */
function makeStorage(initialAlarm = null) {
  let alarm = initialAlarm;
  const calls = { getAlarm: 0, setAlarm: [], deleteAlarm: 0 };
  return {
    calls,
    async getAlarm() {
      calls.getAlarm++;
      return alarm;
    },
    async setAlarm(at) {
      calls.setAlarm.push(at);
      alarm = at;
    },
    async deleteAlarm() {
      calls.deleteAlarm++;
      alarm = null;
    },
    get current() {
      return alarm;
    },
  };
}

test("touch() arms on the first call and calls onRearm with the current time", async () => {
  const storage = makeStorage();
  const idleAlarm = new IdleAlarm(storage, 100_000);
  const rearms = [];
  const before = Date.now();
  const armed = await idleAlarm.touch((nowIso) => rearms.push(nowIso));
  assert.equal(rearms.length, 1);
  assert.ok(Date.parse(rearms[0]) >= before);
  assert.equal(armed, storage.current);
  assert.equal(storage.calls.setAlarm.length, 1);
});

test("touch() throttles at ttl/10: a second call shortly after the first doesn't re-arm", async () => {
  const storage = makeStorage();
  const idleAlarm = new IdleAlarm(storage, 100_000); // ttl/10 = 10_000ms
  let rearmCount = 0;
  const first = await idleAlarm.touch(() => rearmCount++);
  const second = await idleAlarm.touch(() => rearmCount++);
  assert.equal(rearmCount, 1, "the second call within ttl/10 must not re-arm");
  assert.equal(second, first, "returns the deadline actually armed, unchanged");
  assert.equal(storage.calls.setAlarm.length, 1);
});

test("touch() re-arms once the new deadline is more than ttl/10 past the armed one", async () => {
  // A cold-start read (storage.getAlarm()) reports a deadline armed well in
  // the past relative to `now + ttl`: `want - armed` easily exceeds ttl/10
  // (10_000ms here), so this call must re-arm rather than throttle.
  const stale = Date.now() - 1_000_000;
  const storage = makeStorage(stale);
  const idleAlarm = new IdleAlarm(storage, 100_000); // ttl/10 = 10_000ms
  let rearmCount = 0;
  const before = Date.now();
  const rearmed = await idleAlarm.touch((nowIso) => {
    rearmCount++;
    assert.ok(Date.parse(nowIso) >= before);
  });
  assert.equal(rearmCount, 1);
  assert.ok(rearmed > stale);
  assert.equal(storage.calls.setAlarm.length, 1);
});

test("a disabled ttl (0) never arms and clears any existing alarm", async () => {
  const storage = makeStorage(Date.now() + 1000); // pretend an alarm is already armed
  const idleAlarm = new IdleAlarm(storage, 0);
  let rearmCount = 0;
  const result = await idleAlarm.touch(() => rearmCount++);
  assert.equal(result, null);
  assert.equal(rearmCount, 0, "onRearm must not be called when expiry is disabled");
  assert.equal(storage.calls.deleteAlarm, 1);
  assert.equal(storage.current, null);
});

test("a disabled ttl (0) is a no-op when nothing was armed", async () => {
  const storage = makeStorage(null);
  const idleAlarm = new IdleAlarm(storage, 0);
  const result = await idleAlarm.touch(() => {
    throw new Error("must not be called");
  });
  assert.equal(result, null);
  assert.equal(storage.calls.deleteAlarm, 0, "no need to delete an alarm that was never armed");
});

test("onAlarm(): destroys when the persisted lastUsed + ttl is in the past", async () => {
  const storage = makeStorage();
  const idleAlarm = new IdleAlarm(storage, 1000);
  const longAgo = new Date(Date.now() - 5000).toISOString();
  const result = await idleAlarm.onAlarm(longAgo);
  assert.equal(result, "destroy");
  assert.equal(storage.calls.setAlarm.length, 0);
});

test("onAlarm(): re-arms to the true deadline when lastUsed moved since the stale alarm fired", async () => {
  const storage = makeStorage();
  const idleAlarm = new IdleAlarm(storage, 5000);
  // lastUsed just happened -- the (throttled, stale) alarm fired before the
  // true deadline (lastUsed + ttl) arrived.
  const recentlyUsed = new Date(Date.now() - 100).toISOString();
  const result = await idleAlarm.onAlarm(recentlyUsed);
  assert.equal(result, "rearmed");
  assert.equal(storage.calls.setAlarm.length, 1);
  const expectedDeadline = Date.parse(recentlyUsed) + 5000;
  assert.equal(storage.calls.setAlarm[0], expectedDeadline);
});

test("onAlarm(): disabled ttl is a no-op", async () => {
  const storage = makeStorage();
  const idleAlarm = new IdleAlarm(storage, 0);
  const result = await idleAlarm.onAlarm(new Date(0).toISOString());
  assert.equal(result, "disabled");
  assert.equal(storage.calls.setAlarm.length, 0);
});

test("reset() clears the in-memory cache, so the next touch() re-reads storage", async () => {
  const storage = makeStorage();
  const idleAlarm = new IdleAlarm(storage, 100_000);
  await idleAlarm.touch(() => {}); // cold start: falls back to storage.getAlarm() once
  await idleAlarm.touch(() => {}); // cached: no further read
  assert.equal(storage.calls.getAlarm, 1, "the in-memory cache avoids a storage read once armed");
  idleAlarm.reset();
  await idleAlarm.touch(() => {});
  assert.equal(storage.calls.getAlarm, 2, "reset() forces the next touch() to fall back to storage.getAlarm() again");
});
