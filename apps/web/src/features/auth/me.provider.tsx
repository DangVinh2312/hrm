import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { useSession } from './session.provider';
import type { MeClient } from './me.client';

/** How long fetched menus count as fresh (one minute). */
const MENU_STALE_MS = 60_000;

const MeContext = createContext<MeClient | undefined>(undefined);

/** `GET /api/auth/me` client, created once by the composition root (app.tsx) and faked in tests. */
export function MeProvider(props: { readonly client: MeClient; readonly children: ReactNode }) {
  return <MeContext.Provider value={props.client}>{props.children}</MeContext.Provider>;
}

/** Server-granted menus (design §10.2), cached per session; display only, the API decides every action. */
export function useMenus() {
  const { namespace } = useSession();
  const client = useContext(MeContext);
  if (!client) throw new Error('useMenus must be used inside MeProvider');
  return useQuery({
    queryKey: [namespace, 'auth', 'me'],
    queryFn: ({ signal }) => client.me(signal),
    // ADR 0041 Q17: the menus change only with a grant, so a focus or remount need not refetch them;
    // writes that can change them invalidate this key. Display only, the API decides each action.
    staleTime: MENU_STALE_MS,
  });
}
