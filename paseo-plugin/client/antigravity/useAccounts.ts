import { useRpc, useSubscription } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { listAccountsRpc, watchAccountsSubscription, type AccountsState } from "../../shared/antigravity/contracts";

// NOTE: Never name a top-level client/shared identifier `key` — esbuild renames
// its `__copyProps` loop variable to `key2`, defeating Paseo's Hermes eager
// interop rewrite (`get: () => from[key]` -> `value: from[key]`) and causing
// namespace imports (`import * as PaseoUi`) to resolve every property to the
// last export on iOS Hermes.
const ACCOUNTS_QUERY_KEY = ["antigravity-accounts", "state"] as const;

export function useAccounts() {
  const list = useRpc(listAccountsRpc);
  const cache = useQueryClient();
  const observed = useRef(-1);
  const query = useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: () => list({}),
    staleTime: Infinity,
    structuralSharing(old: unknown, next: unknown) {
      const previous = old as AccountsState | undefined;
      return previous && previous.revision > (next as AccountsState).revision ? previous : next;
    },
  });
  const invalidate = () => cache.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
  const watch = useSubscription(watchAccountsSubscription, {}, ({ revision }) => {
    observed.current = Math.max(observed.current, revision);
    if (revision > (cache.getQueryData<AccountsState>(ACCOUNTS_QUERY_KEY)?.revision ?? -1)) void invalidate();
  });
  // An event can arrive before the very first list request resolves.
  useEffect(() => {
    if (query.data && query.data.revision < observed.current) void cache.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
  }, [cache, query.data, query.dataUpdatedAt]);
  // Guard against out-of-order RPC responses overwriting a newer revision in the cache.
  const accept = useCallback(
    (state: AccountsState) => {
      cache.setQueryData<AccountsState>(ACCOUNTS_QUERY_KEY, (previous) =>
        previous && previous.revision > state.revision ? previous : state,
      );
    },
    [cache],
  );
  return { ...query, watch, accept };
}
