import assert from "node:assert/strict";
import { it } from "node:test";
import { retrySourceSynchronization } from "../src/epay-compat/source-sync-retry.ts";

it("recaptures after a transient timeout and retains bounded failure reporting", async () => {
  let calls=0, active=false;
  const delays:number[]=[];
  const notices:number[]=[];
  const capture=await retrySourceSynchronization({synchronize:async()=>{
    assert.equal(active,false);active=true;
    try {if(++calls<3)throw new Error("temporary source timeout");return {sequence:3};}
    finally {active=false;}
  },onRetry:attempt=>notices.push(attempt),wait:async delay=>{assert.equal(active,false);delays.push(delay);}});
  assert.deepEqual(capture,{sequence:3});
  assert.deepEqual(notices,[1,2]);assert.deepEqual(delays,[1_000,3_000]);
});

it("never turns repeated synchronization failures into a successful result", async () => {
  let calls=0;
  const failure=new Error("snapshot authentication failed");
  await assert.rejects(retrySourceSynchronization({synchronize:async()=>{calls++;throw failure;},onRetry:()=>undefined,wait:async()=>undefined}),error=>error===failure);
  assert.equal(calls,3);
});

it("passes the original failure to diagnostics before another fresh attempt", async () => {
  const timeout = Object.assign(new Error("query timed out"), { code: "PROTOCOL_SEQUENCE_TIMEOUT" });
  const notices: unknown[] = [];
  let calls = 0;
  assert.equal(await retrySourceSynchronization({
    synchronize: async () => { if (++calls === 1) throw timeout; return "fresh-capture"; },
    onRetry: (attempt, delay, error) => { notices.push([attempt, delay, error]); }, wait: async () => undefined,
  }), "fresh-capture");
  assert.deepEqual(notices, [[1, 1000, timeout]]);
});
