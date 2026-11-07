import { readFileSync, readlinkSync, realpathSync } from "node:fs";

export interface LiveStateProcessIdentity {
  readonly pid: number;
  readonly startTicks: string;
  readonly executable: string;
  readonly uid: number;
  readonly args: readonly string[];
}

function startTicks(stat: string, pid: number): string {
  const end = stat.lastIndexOf(") ");
  if (!stat.startsWith(`${pid} (`) || end < 0) throw new Error("invalid process stat");
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  const ticks = fields[19];
  if (fields.length < 20 || !ticks || !/^\d+$/.test(ticks)) throw new Error("invalid process start time");
  return ticks;
}

function processUid(status: string): number {
  const match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
  if (!match || match.slice(1).some(value => value !== match[1])) throw new Error("process UID is unavailable or changing");
  const uid = Number(match[1]);
  if (!Number.isSafeInteger(uid)) throw new Error("invalid process UID");
  return uid;
}

// Re-check immediately before each signal or debugger connection; this is not a PID lock.
export function verifyLiveStateProcess(expected: LiveStateProcessIdentity): void {
  if (process.platform !== "linux") throw new Error("process identity verification requires Linux");
  if (!Number.isSafeInteger(expected.pid) || expected.pid < 1 || !/^\d+$/.test(expected.startTicks) || !Number.isSafeInteger(expected.uid) || expected.uid < 0 || !expected.executable || !expected.args.length || expected.args.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("invalid expected process identity");
  }
  const root = `/proc/${expected.pid}`;
  const before = startTicks(readFileSync(`${root}/stat`, "utf8"), expected.pid);
  const executable = readlinkSync(`${root}/exe`);
  const uid = processUid(readFileSync(`${root}/status`, "utf8"));
  const command = readFileSync(`${root}/cmdline`);
  if (command.length === 0 || command.length > 1024 * 1024 || command.at(-1) !== 0) throw new Error("invalid process command line");
  const args = command.subarray(0, -1).toString("utf8").split("\0");
  const after = startTicks(readFileSync(`${root}/stat`, "utf8"), expected.pid);
  if (before !== after || before !== expected.startTicks || executable !== realpathSync(expected.executable) || uid !== expected.uid || args.length !== expected.args.length || args.some((arg, index) => arg !== expected.args[index])) {
    throw new Error("target process identity mismatch");
  }
}
