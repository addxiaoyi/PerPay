export function parseLegacyCents(value: string): number {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error("invalid legacy monetary amount");
  const cents = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("legacy monetary amount exceeds the safe integer range");
  return Number(cents);
}
