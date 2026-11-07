import { createHash, createPrivateKey, createPublicKey, X509Certificate, type KeyObject } from "node:crypto";
import type { AlipayOrderExpectation } from "./alipay-evidence.ts";
import { alipaySigningFingerprint } from "./isolated-alipay-client.ts";

export type AlipayQueryAccount = Readonly<{
  appId: string; sellerId: string; signingFingerprint: string;
  platformFingerprint: string; validFrom: number; validUntil: number;
}>;
const verifiedAccounts = new WeakSet<AlipayQueryAccount>();
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const platformFingerprint = (pem: string) => digest(createPublicKey(pem).export({ type: "spki", format: "der" }));

// The certificate hash is pinned by the independently checked channel provisioning report.
export function verifyAlipayQueryAccount(input: {
  appId: string; sellerId: string; privateKey: KeyObject | string;
  platformPublicKey: string; certificate: string; certificateSha256: string;
}, now: number): AlipayQueryAccount {
  if (!/^\d{16}$/.test(input.appId) || !/^2088\d{12}$/.test(input.sellerId) || !/^[a-f0-9]{64}$/.test(input.certificateSha256) || !Number.isSafeInteger(now)) throw new Error("invalid Alipay query account");
  const certificate = new X509Certificate(input.certificate);
  const commonName = certificate.toLegacyObject().subject.CN;
  const sellers = typeof commonName === "string" ? commonName.match(/\b2088\d{12}\b/g) : null;
  const signing = typeof input.privateKey === "string" ? createPrivateKey(input.privateKey) : input.privateKey;
  const signingFingerprint = alipaySigningFingerprint(signing);
  const validFrom = Date.parse(certificate.validFrom), validUntil = Date.parse(certificate.validTo);
  if (digest(certificate.raw) !== input.certificateSha256 || sellers?.length !== 1 || sellers[0] !== input.sellerId ||
      digest(certificate.publicKey.export({ type: "spki", format: "der" })) !== signingFingerprint ||
      !Number.isSafeInteger(validFrom) || !Number.isSafeInteger(validUntil) || now < validFrom || now >= validUntil) throw new Error("Alipay query certificate account or key mismatch");
  const account = Object.freeze({ appId: input.appId, sellerId: input.sellerId, signingFingerprint,
    platformFingerprint: platformFingerprint(input.platformPublicKey), validFrom, validUntil });
  verifiedAccounts.add(account);
  return account;
}

export function requireAlipayQueryAccount(account: AlipayQueryAccount, expected: Pick<AlipayOrderExpectation, "appId" | "sellerId" | "platformPublicKey">, now: number): void {
  if (!verifiedAccounts.has(account) || account.appId !== expected.appId || account.sellerId !== expected.sellerId ||
      account.platformFingerprint !== platformFingerprint(expected.platformPublicKey) || now < account.validFrom || now >= account.validUntil) throw new Error("Alipay query account is unverified or mismatched");
}
