import { useQuery } from '@tanstack/react-query';
import { useSession } from '../auth/session.provider';
import { useSettingClient } from './setting-services.provider';

/** The profile changes rarely and only through a setting update, which invalidates this key. */
const PROFILE_STALE_MS = 60_000;

/**
 * Company name and default language for the shell (`setting.readProfile`, ADR 0041 §5: inside the
 * app only). An account without the permission gets a 404; that is not an error to show, the shell
 * simply has no company information, so there is no retry and nobody reads `error`.
 */
export function useCompanyProfile() {
  const { namespace } = useSession();
  const client = useSettingClient();
  return useQuery({
    queryKey: [namespace, 'setting', 'profile'],
    queryFn: ({ signal }) => client.profile(signal),
    staleTime: PROFILE_STALE_MS,
    retry: false,
  });
}
