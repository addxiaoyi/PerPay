import { z } from 'zod';
import type { AppDatabase } from '../database/database.ts';
import type { InvoiceAccess } from '../invoices/model.ts';
import { createBalancePayments } from './balance-payment.ts';

export const topupResumeInput = z.object({ orderId: z.uuid(), token: z.string().min(1).max(256) }).strict();
type Options = { database: Pick<AppDatabase, 'read' | 'write' | 'instanceId'>; masterKey: Uint8Array; publicOrigin: string; basePath: string; clock?: () => number };

export function topupReturnUrl(options: Options, access: InvoiceAccess, resume?: z.infer<typeof topupResumeInput>): string {
  const root = options.basePath === '/' ? '' : options.basePath;
  const url = new URL(`${root}/merchant/topups`, options.publicOrigin);
  url.searchParams.set('merchantId', access.merchantId);
  if (!resume) return url.href;
  // Only the original signed checkout may supply a continuation; callers cannot redirect to another site.
  createBalancePayments({ ...options, enabled: () => false }).inspect(access, resume.orderId, resume.token);
  url.searchParams.set('resumeOrderId', resume.orderId);
  url.searchParams.set('resumeToken', resume.token);
  return url.href;
}
