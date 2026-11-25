import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import type { captureSharedCutoff } from "./shared-cutoff.ts";

export const SOURCE_SYNC_PURPOSE = "epay:config:shared-source-delivery";

// Collectors only need encryption; importing the HTTP owner also loads its full financial graph.
export function sealSharedCapture(cipher: RuntimeSecretCipher, capture: Awaited<ReturnType<typeof captureSharedCutoff>>, issuedAt: number) {
  const sealed = cipher.encrypt(SOURCE_SYNC_PURPOSE, 1, JSON.stringify({ version: 1, issuedAt, capture }));
  return { version: 1 as const, nonce: sealed.nonce.toString("hex"), ciphertext: sealed.ciphertext.toString("hex"), authenticationTag: sealed.authenticationTag.toString("hex") };
}
