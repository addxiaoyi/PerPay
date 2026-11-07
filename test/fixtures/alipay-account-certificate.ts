import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function accountCertificate(directory: string, privateKey: string, sellerId = "2088000000000000") {
  const keyPath = join(directory, "fixture-signing.pem"), path = join(directory, "fixture-account.pem");
  writeFileSync(keyPath, privateKey, { mode: 0o600 });
  const windowsOpenSSL = "C:/Program Files/Git/usr/bin/openssl.exe";
  const openssl = process.env.TEST_OPENSSL ?? (process.platform === "win32" && existsSync(windowsOpenSSL) ? windowsOpenSSL : "openssl");
  execFileSync(openssl, ["req", "-new", "-x509", "-key", keyPath, "-out", path, "-days", "2", "-subj", `/C=CN/O=Synthetic fixture/CN=${sellerId}`], { stdio: "pipe", windowsHide: true });
  const certificate = readFileSync(path, "utf8");
  const certificateSha256 = createHash("sha256").update(new X509Certificate(certificate).raw).digest("hex");
  return { path, certificate, certificateSha256 };
}
