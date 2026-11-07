import { z } from "zod";
import { parseStrictJson } from "../http/strict-json.ts";
import { MerchantAccessError } from "./merchant-access.ts";

const MAX_RESPONSE_BYTES = 64 * 1024;
export const memberId = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const memberCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("grant"), userId: memberId }).strict(),
  z.object({ action: z.literal("set_status"), userId: memberId, enabled: z.boolean() }).strict(),
]);
const memberRows = z.array(z.object({ userId: memberId, username: z.string().max(256), enabled: z.boolean(), addedAt: z.string().max(64).optional() })).max(200);

export class MemberChangeError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409) { super("main merchant member change was rejected"); this.status = status; }
}

type Options = { identityOrigin: string; publicOrigin: string; cookie: string; merchantId: string; send?: typeof fetch };

// Membership has one authority. Never maintain a second, eventually consistent permission list in SQLite.
async function requestMembers(options: Options, command?: z.infer<typeof memberCommand>) {
  const origin = new URL(options.identityOrigin);
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname) || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) throw new MerchantAccessError("unavailable");
  const path = `/api/admin/merchants/${encodeURIComponent(options.merchantId)}/members`;
  const suffix = command?.action === "set_status" ? `/${encodeURIComponent(command.userId)}` : "";
  const body = command?.action === "grant" ? { userId: command.userId } : command ? { enabled: command.enabled } : undefined;
  let response: Response;
  try {
    response = await (options.send ?? fetch)(new URL(path + suffix, origin), {
      method: command?.action === "set_status" ? "PATCH" : command ? "POST" : "GET",
      headers: { accept: "application/json", cookie: options.cookie,
        ...(body ? { "content-type": "application/json", origin: options.publicOrigin, host: new URL(options.publicOrigin).host } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000),
    });
  } catch { throw new MerchantAccessError("unavailable"); }
  if (response.status === 401) throw new MerchantAccessError("unauthenticated");
  if (response.status === 403) throw new MerchantAccessError("forbidden");
  if ([400, 404, 409].includes(response.status)) throw new MemberChangeError(response.status as 400 | 404 | 409);
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json") || !response.body) throw new MerchantAccessError("unavailable");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new MerchantAccessError("unavailable");
      chunks.push(chunk.value);
    }
    const parsed = parseStrictJson(Buffer.concat(chunks)) as { ok?: unknown; members?: unknown };
    if (!parsed || parsed.ok !== true) throw new MerchantAccessError("unavailable");
    // Mutations can contain extra main-site fields; none are relayed to the browser.
    return command ? null : memberRows.parse(parsed.members);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function readMainMembers(options: Options) {
  const members = await requestMembers(options);
  if (!members || new Set(members.map(member => member.userId)).size !== members.length) throw new MerchantAccessError("unavailable");
  return { merchantId: options.merchantId, members };
}

export async function changeMainMember(options: Options, input: z.infer<typeof memberCommand>) {
  await requestMembers(options, memberCommand.parse(input));
  const confirmed = await readMainMembers(options);
  const member = confirmed.members.find(row => row.userId === input.userId);
  if (!member || member.enabled !== (input.action === "grant" ? true : input.enabled)) throw new MerchantAccessError("unavailable");
  return confirmed;
}
