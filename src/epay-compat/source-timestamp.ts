export function parseSourceTimestamp(value: unknown, offsetMinutes: number): number {
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 840) throw new Error("invalid source timezone offset");
  const parts = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value) : null;
  if (!parts) throw new Error("invalid source timestamp");
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const millis = Number((parts[7] ?? "").padEnd(3, "0"));
  if (year < 1970 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) throw new Error("invalid source timestamp");
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const date = new Date(utc);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error("invalid source timestamp");
  const epoch = utc - offsetMinutes * 60_000;
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("invalid source timestamp");
  return epoch;
}
