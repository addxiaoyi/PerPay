import { createHash, timingSafeEqual } from "node:crypto";

export type EPaySignParams = Readonly<Record<string, string | number | null | undefined>>;

export function epaySignString(params: EPaySignParams): string {
  return Object.entries(params)
    .filter(([key, value]) => key !== "sign" && key !== "sign_type" && value !== "" && value != null)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");
}

export function epaySign(params: EPaySignParams, secret: string): string {
  if (!secret) throw new Error("EPay signing key must not be empty");
  return createHash("md5").update(epaySignString(params) + secret, "utf8").digest("hex");
}

export function verifyEPaySign(params: EPaySignParams, secret: string): boolean {
  const signature = params.sign;
  if (!secret || typeof signature !== "string" || !/^[a-f0-9]{32}$/i.test(signature)) return false;
  const expected = Buffer.from(epaySign(params, secret), "hex");
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
