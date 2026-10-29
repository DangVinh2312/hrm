import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthClient, SessionView } from './auth.client';

export interface SessionContextValue {
  readonly auth: AuthClient;
  /** `undefined` while loading, `null` when signed out. */
  readonly session: SessionView | null | undefined;
  /** The session could not be checked (network/server); not the same as signed out. */
  readonly failed: boolean;
  /** Part of every protected query key: a new session never reads the previous one's cache. */
  readonly namespace: number;
  readonly logout: () => Promise<void>;
  /**
   * The server already ended every session (account-security change): drop all
   * protected state locally without calling the API.
   */
  readonly expire: () => Promise<void>;
  readonly retry: () => void;
}

const SessionContext = createContext<SessionContextValue | undefined>(undefined);

export interface SessionEvents {
  readonly subscribe: (listener: () => void) => () => void;
}

export function SessionProvider(props: {
  readonly auth: AuthClient;
  readonly events: SessionEvents;
  readonly children: ReactNode;
}) {
  const { auth, events, children } = props;
  const queryClient = useQueryClient();
  const [namespace, setNamespace] = useState(0);
  const query = useQuery({
    queryKey: ['session', namespace],
    queryFn: ({ signal }) => auth.session(signal),
    retry: false,
  });

  // In-flight requests of the old session are aborted and every cached DTO is dropped before the
  // namespace moves on, so a late answer cannot repopulate what the next user sees.
  const reset = useCallback(async () => {
    await queryClient.cancelQueries();
    queryClient.clear();
    setNamespace((value) => value + 1);
  }, [queryClient]);

  useEffect(
    () =>
      events.subscribe(() => {
        reset().catch(() => undefined);
      }),
    [events, reset],
  );

  // Reset only once the API confirmed the logout (an already ended session counts). A network
  // failure leaves the server session as it was: the page keeps its error and the user retries;
  // if the request did land, the next protected call answers 401 and resets through `events`.
  const logout = useCallback(async () => {
    await auth.logout();
    await reset();
  }, [auth, reset]);

  const value = useMemo<SessionContextValue>(
    () => ({
      auth,
      session: query.isPending ? undefined : query.isError ? null : query.data,
      failed: query.isError,
      namespace,
      logout,
      expire: reset,
      retry: () => {
        query.refetch().catch(() => undefined);
      },
    }),
    [auth, query, namespace, logout, reset],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}

/** Composition-owned signal: the query client reports 401, the session provider resets. */
export function createSessionEvents(): SessionEvents & { readonly notify: () => void } {
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}
