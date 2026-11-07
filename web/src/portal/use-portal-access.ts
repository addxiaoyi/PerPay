import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { merchantRequest, type ConsoleMerchant } from "@/api/merchant-console";

type Directory = { userId?: string | null; merchants: ConsoleMerchant[]; administrationEnabled: boolean; collectionChannels?: string[] };
export function usePortalAccess() {
  const client = useQueryClient();
  const [accepted, setAccepted] = useState<string | null>(null), [suspended, setSuspended] = useState(false);
  const directory = useQuery({ queryKey: ["merchant-console", "directory"], queryFn: ({ signal }) => merchantRequest<Directory>("access", {}, signal),
    retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: "always", refetchOnReconnect: "always", refetchOnMount: "always" });
  const identity = directory.data ? JSON.stringify([directory.data.userId ?? null, directory.data.merchants.map(merchant => [merchant.merchantId, merchant.role]).sort()]) : null;
  const clearRecords = useCallback(async () => {
    const scope = { queryKey: ["merchant-console"], predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[1] !== "directory" };
    await client.cancelQueries(scope);
    client.removeQueries(scope);
  }, [client]);

  useEffect(() => {
    if (!identity || directory.isFetching || directory.isError || accepted === identity) return;
    let current = true;
    // Cancel before eviction so a previous account's slow response cannot refill the cache.
    void clearRecords().then(() => { if (current) setAccepted(identity); });
    return () => { current = false; };
  }, [identity, accepted, directory.isFetching, directory.isError, clearRecords]);

  const refresh = useCallback(async () => {
    setSuspended(true);
    try { await clearRecords(); await directory.refetch(); }
    finally { setSuspended(false); }
  }, [clearRecords, directory.refetch]);

  useEffect(() => {
    const restored = (event: PageTransitionEvent) => { if (event.persisted) void refresh(); };
    const visibility = () => { if (document.hidden) setSuspended(true); else void refresh(); };
    window.addEventListener("pageshow", restored);
    document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("pageshow", restored); document.removeEventListener("visibilitychange", visibility); };
  }, [refresh]);

  const verifying = suspended || directory.isFetching || Boolean(identity && accepted !== identity);
  return { directory, verifying, refresh };
}
