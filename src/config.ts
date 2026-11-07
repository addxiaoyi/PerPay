import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";

import { z } from "zod";

import {
  parseTrustedProxyPolicy,
  type TrustedProxyPolicy,
} from "./infrastructure/network/trusted-proxy.ts";
import { pathsOverlap } from "./infrastructure/storage/path-separation.ts";
import { syncDirectory } from "./database/maintenance-lock.ts";

const MASTER_KEY_BYTES = 32;
const MASTER_KEY_HEX_LENGTH = MASTER_KEY_BYTES * 2;
const masterKeyHexPattern = /^[0-9a-fA-F]{64}$/;

const rawDeploymentConfigSchema = z.object({
  PERPAY_HOST: z.string().trim().min(1).default("0.0.0.0"),
  PERPAY_PORT: z.coerce.number().int().min(1).max(65535).default(6190),
  PERPAY_DATA_DIR: z.string().trim().min(1).default("./data"),
  PERPAY_BACKUP_DIR: z.string().trim().min(1).default("/backups"),
  PERPAY_MASTER_KEY: z.string().length(MASTER_KEY_HEX_LENGTH).regex(masterKeyHexPattern).optional(),
  PERPAY_SECRETS_DIR: z.string().trim().min(1).optional(),
  PERPAY_PUBLIC_URL: z.string().trim().min(1).default("http://localhost:6190"),
  PERPAY_BASE_PATH: z.string().trim().default("/"),
  PERPAY_TRUSTED_PROXY_CIDRS: z.string().default(""),
  PERPAY_SETUP_TOKEN_ENABLED: z.enum(["true", "false"]).default("false"),
  PERPAY_EPAY_SHADOW_IDENTITY_ORIGIN: z.string().trim().min(1).optional(),
  PERPAY_EPAY_SHADOW_MAIN_ORDERS: z.enum(["true", "false"]).default("false"),
  PERPAY_EPAY_SHADOW_BALANCE: z.enum(["true", "false"]).default("false"),
  PERPAY_EPAY_GATEWAY_MODE: z.enum(["off", "maintenance", "live"]).default("off"),
  PERPAY_EPAY_CALLBACK_DELIVERY: z.enum(["true", "false"]).default("false"),
  PERPAY_EPAY_ALIPAY_CHANNEL_ID: z.coerce.number().int().positive().optional(),
  PERPAY_EPAY_ALIPAY_CERTIFICATE_FILE: z.string().trim().min(1).optional(),
  PERPAY_EPAY_MAIN_BRIDGE_SECRET_FILE: z.string().trim().min(1).optional(),
  PERPAY_EPAY_INVOICE_FEE_CENTS: z.string().regex(/^(0|[1-9]\d{0,8})$/).transform(Number).optional(),
  PERPAY_EPAY_INVOICE_ENABLED: z.enum(["true", "false"]).default("false"),
  PERPAY_EPAY_WECHAT_CREDENTIAL_ID: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  PERPAY_EPAY_WECHAT_SIGNING_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  // Kept as a non-Compose compatibility fallback for local health probes.
  PERPAY_BACKUP_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(60 * 60)
    .max(7 * 24 * 60 * 60)
    .default(24 * 60 * 60),
});

export interface DeploymentConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly backupDir: string;
  readonly databasePath: string;
  readonly masterKey: Buffer;
  readonly publicOrigin: string;
  readonly basePath: string;
  readonly secureCookies: boolean;
  readonly setupTokenEnabled: boolean;
  readonly trustedProxy: TrustedProxyPolicy;
  readonly backupIntervalMilliseconds: number;
  readonly merchantShadowIdentityOrigin?: string | undefined;
  readonly merchantShadowMainOrders: boolean;
  readonly merchantShadowBalance: boolean;
  readonly epayGateway?: {
    readonly mode: "maintenance" | "live";
    readonly callbackDelivery: boolean;
    readonly alipayChannelId?: number;
    readonly alipayCertificateFile?: string;
    readonly mainBridgeSecretFile?: string;
    readonly invoiceFeeCents?: number;
    readonly invoiceEnabled?: boolean;
    readonly wechatCredentialId?: string;
    readonly wechatSigningKeyId?: string;
  };
}

/** Temporary name retained while callers migrate to DeploymentConfig. */
export type AppConfig = DeploymentConfig;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): DeploymentConfig {
  const parsed = rawDeploymentConfigSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`configuration validation failed: ${z.prettifyError(parsed.error)}`);
  }

  if (isIP(parsed.data.PERPAY_HOST) === 0 && parsed.data.PERPAY_HOST !== "localhost") {
    throw new Error("configuration validation failed: PERPAY_HOST must be an IP address or localhost");
  }

  const shadowOrigin = parsed.data.PERPAY_EPAY_SHADOW_IDENTITY_ORIGIN;
  if (parsed.data.PERPAY_EPAY_SHADOW_MAIN_ORDERS === "true" && !shadowOrigin) {
    throw new Error("configuration validation failed: EPay shadow main orders require a shadow identity origin");
  }
  if (parsed.data.PERPAY_EPAY_SHADOW_BALANCE === "true" && !shadowOrigin) {
    throw new Error("configuration validation failed: EPay shadow balance requires a shadow identity origin");
  }
  if (shadowOrigin) {
    let identityUrl: URL;
    try { identityUrl = new URL(shadowOrigin); } catch { throw new Error("configuration validation failed: invalid EPay shadow identity origin"); }
    if (!["127.0.0.1", "::1"].includes(parsed.data.PERPAY_HOST) || identityUrl.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(identityUrl.hostname) || identityUrl.username || identityUrl.password || identityUrl.pathname !== "/" || identityUrl.search || identityUrl.hash) {
      throw new Error("configuration validation failed: EPay shadow requires loopback server and identity origins");
    }
  }

  const publicUrl = parsePublicUrl(parsed.data.PERPAY_PUBLIC_URL);
  const basePath = parseBasePath(parsed.data.PERPAY_BASE_PATH);
  const gatewayMode = parsed.data.PERPAY_EPAY_GATEWAY_MODE;
  const gatewayDelivery = parsed.data.PERPAY_EPAY_CALLBACK_DELIVERY === "true";
  if (gatewayMode === "off" && gatewayDelivery) throw new Error("EPay callback delivery requires the gateway runtime");
  if (gatewayMode !== "off" && publicUrl.protocol !== "https:") throw new Error("EPay gateway requires an HTTPS public URL");
  const wechatCredential = parsed.data.PERPAY_EPAY_WECHAT_CREDENTIAL_ID;
  const wechatSigningKey = parsed.data.PERPAY_EPAY_WECHAT_SIGNING_KEY_ID;
  if (Boolean(wechatCredential) !== Boolean(wechatSigningKey)) throw new Error("EPay WeChat credential and signing key must be configured together");
  if (gatewayMode === "live" && (!gatewayDelivery || (!parsed.data.PERPAY_EPAY_ALIPAY_CHANNEL_ID && !wechatCredential))) throw new Error("EPay live mode requires a channel and callback delivery");
  let trustedProxy: TrustedProxyPolicy;
  try {
    trustedProxy = parseTrustedProxyPolicy(parsed.data.PERPAY_TRUSTED_PROXY_CIDRS);
  } catch (error) {
    throw new Error(
      `configuration validation failed: ${
        error instanceof Error ? error.message : "PERPAY_TRUSTED_PROXY_CIDRS is invalid"
      }`,
      { cause: error },
    );
  }
  if (publicUrl.protocol === "https:" && trustedProxy.cidrs.length === 0) {
    throw new Error(
      "configuration validation failed: HTTPS deployments must declare their directly connected trusted proxy with PERPAY_TRUSTED_PROXY_CIDRS",
    );
  }

  const dataDir = resolve(parsed.data.PERPAY_DATA_DIR);
  const backupDir = resolve(parsed.data.PERPAY_BACKUP_DIR);
  if (pathsOverlap(dataDir, backupDir)) {
    throw new Error(
      "configuration validation failed: PERPAY_DATA_DIR and PERPAY_BACKUP_DIR must be separate",
    );
  }

  const secretsDirectory = parsed.data.PERPAY_SECRETS_DIR === undefined
    ? null
    : resolve(parsed.data.PERPAY_SECRETS_DIR);
  const masterKey = resolveMasterKey(
    parsed.data.PERPAY_MASTER_KEY,
    secretsDirectory,
    resolve(dataDir, "perpay.sqlite3"),
  );

  return Object.freeze({
    host: parsed.data.PERPAY_HOST,
    port: parsed.data.PERPAY_PORT,
    dataDir,
    backupDir,
    databasePath: resolve(dataDir, "perpay.sqlite3"),
    masterKey,
    publicOrigin: publicUrl.origin,
    basePath,
    secureCookies: publicUrl.protocol === "https:",
    setupTokenEnabled: parsed.data.PERPAY_SETUP_TOKEN_ENABLED === "true",
    trustedProxy,
    backupIntervalMilliseconds: parsed.data.PERPAY_BACKUP_INTERVAL_SECONDS * 1_000,
    merchantShadowMainOrders: parsed.data.PERPAY_EPAY_SHADOW_MAIN_ORDERS === "true",
    merchantShadowBalance: parsed.data.PERPAY_EPAY_SHADOW_BALANCE === "true",
    ...(shadowOrigin ? { merchantShadowIdentityOrigin: shadowOrigin } : {}),
    ...(gatewayMode === "off" ? {} : { epayGateway: {
      mode: gatewayMode, callbackDelivery: gatewayDelivery,
      ...(parsed.data.PERPAY_EPAY_MAIN_BRIDGE_SECRET_FILE ? { mainBridgeSecretFile: parsed.data.PERPAY_EPAY_MAIN_BRIDGE_SECRET_FILE } : {}),
      ...(parsed.data.PERPAY_EPAY_INVOICE_FEE_CENTS === undefined ? {} : { invoiceFeeCents: parsed.data.PERPAY_EPAY_INVOICE_FEE_CENTS }),
      ...(parsed.data.PERPAY_EPAY_INVOICE_ENABLED === "true" ? { invoiceEnabled: true } : {}),
      ...(parsed.data.PERPAY_EPAY_ALIPAY_CHANNEL_ID ? { alipayChannelId: parsed.data.PERPAY_EPAY_ALIPAY_CHANNEL_ID } : {}),
      ...(parsed.data.PERPAY_EPAY_ALIPAY_CERTIFICATE_FILE ? { alipayCertificateFile: parsed.data.PERPAY_EPAY_ALIPAY_CERTIFICATE_FILE } : {}),
      ...(wechatCredential ? { wechatCredentialId: wechatCredential } : {}),
      ...(wechatSigningKey ? { wechatSigningKeyId: wechatSigningKey } : {}),
    } }),
  });
}

function parseBasePath(value: string): string {
  if (value === "/") return value;
  if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(value) || value.split("/").some(segment => segment === "." || segment === "..")) {
    throw new Error("configuration validation failed: PERPAY_BASE_PATH must be / or a normalized absolute path");
  }
  return value;
}

function resolveMasterKey(
  configured: string | undefined,
  secretsDirectory: string | null,
  databasePath: string,
): Buffer {
  if (configured !== undefined) {
    const key = Buffer.from(configured, "hex");
    if (key.byteLength !== MASTER_KEY_BYTES) {
      throw new Error("configuration validation failed: PERPAY_MASTER_KEY must encode exactly 32 bytes");
    }
    return key;
  }
  if (secretsDirectory === null) {
    throw new Error("configuration validation failed: set PERPAY_SECRETS_DIR or PERPAY_MASTER_KEY");
  }
  mkdirSync(secretsDirectory, { recursive: true, mode: 0o700 });
  const secretsStat = lstatSync(secretsDirectory);
  if (secretsStat.isSymbolicLink() || !secretsStat.isDirectory()) {
    throw new Error("configuration validation failed: secrets directory must be an ordinary directory");
  }
  if (process.platform !== "win32" && (secretsStat.mode & 0o777) !== 0o700) chmodSync(secretsDirectory, 0o700);
  const path = resolve(secretsDirectory, "master-key");
  if (existsSync(databasePath) && lstatSync(databasePath).size > 0 && !existsSync(path)) {
    throw new Error("configuration validation failed: master-key is missing for an existing database");
  }
  if (existsSync(path)) return readMasterKey(path);
  const value = randomBytes(MASTER_KEY_BYTES).toString("hex");
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${value}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    if (process.platform !== "win32") chmodSync(temporary, 0o600);
    if (process.platform !== "win32") {
      const handle = openSync(temporary, "r");
      try { fsyncSync(handle); } finally { closeSync(handle); }
    }
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  } finally {
    unlinkSync(temporary);
  }
  syncDirectory(secretsDirectory);
  return readMasterKey(path);
}

function readMasterKey(path: string): Buffer {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error("configuration validation failed: master-key must be a private ordinary file");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) chmodSync(path, 0o600);
  const value = readFileSync(path, "utf8").trim();
  if (!masterKeyHexPattern.test(value)) {
    throw new Error("configuration validation failed: master-key file must contain 64 hexadecimal characters");
  }
  return Buffer.from(value, "hex");
}

function parsePublicUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("configuration validation failed: PERPAY_PUBLIC_URL must be an absolute URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("configuration validation failed: PERPAY_PUBLIC_URL must use HTTP or HTTPS");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error(
      "configuration validation failed: plain HTTP is only allowed for a loopback PERPAY_PUBLIC_URL",
    );
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "configuration validation failed: PERPAY_PUBLIC_URL must contain only an origin",
    );
  }
  return url;
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost") return true;
  const address = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const family = isIP(address);
  if (family === 4) return address.startsWith("127.");
  return family === 6 && address === "::1";
}
