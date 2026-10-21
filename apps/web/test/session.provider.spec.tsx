import { useQuery } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import { useSession } from '../src/features/auth/session.provider';
import { ApiError } from '../src/infrastructure/http.client';
import { fakeAuth, renderRoutes } from './render.helper';

const userA = { userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11', method: 'oidc', assurance: 'oidc' };
const userB = { userId: '7c2d3f1e-1b2a-4c5d-8e9f-0a1b2c3d4e5f', method: 'oidc', assurance: 'oidc' };

/** A protected page whose data request can be held open across a logout. */
function Probe(props: { readonly load: (ns: number) => Promise<string> }) {
  const { namespace, logout, session } = useSession();
  const data = useQuery({
    queryKey: ['probe', namespace],
    queryFn: () => props.load(namespace),
  });
  return (
    <div>
      <span>user:{session?.userId}</span>
      <span>data:{data.data ?? '-'}</span>
      <button onClick={() => void logout()}>logout</button>
    </div>
  );
}

describe('session lifecycle', () => {
  it('a late answer for user A never shows up after logout and login as user B', async () => {
    let releaseA: (value: string) => void = () => undefined;
    const load = vi.fn((ns: number) =>
      ns === 0 ? new Promise<string>((resolve) => (releaseA = resolve)) : Promise.resolve('B-data'),
    );
    const sessions = [userA, userB];
    const auth = fakeAuth({ session: () => Promise.resolve(sessions.shift() ?? null) });
    const probeRoutes = [
      ...routes.filter((r) => r.path !== '/'),
      { path: '/probe', element: <Probe load={load} /> },
    ];
    const { router } = renderRoutes(probeRoutes, auth, '/probe');
    expect(await screen.findByText(`user:${userA.userId}`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'logout' }));
    // User B is now signed in (next session answer); only then does A's request finish.
    expect(await screen.findByText(`user:${userB.userId}`)).toBeInTheDocument();
    releaseA('A-secret');
    expect(await screen.findByText('data:B-data')).toBeInTheDocument();
    expect(screen.queryByText('data:A-secret')).toBeNull();
    expect(router.state.location.pathname).toBe('/probe');
  });

  it('a logout lost to the network is not retried and keeps the server session', async () => {
    const logout = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    const session = vi.fn(() => Promise.resolve(userA));
    renderRoutes(routes, fakeAuth({ session, logout }), '/');
    await userEvent.click(await screen.findByRole('button', { name: 'Đăng xuất' }));
    expect(await screen.findByText('Không đăng xuất được. Vui lòng thử lại.')).toBeInTheDocument();
    expect(screen.getByText('Bạn đã đăng nhập.')).toBeInTheDocument();
    expect(logout).toHaveBeenCalledTimes(1);
    // The outcome is unknown: the session is only re-read when the user acts again.
    expect(session).toHaveBeenCalledTimes(1);
  });

  it('a 401 from any query ends the session and returns to /login', async () => {
    let signedIn = true;
    const auth = fakeAuth({
      session: () => Promise.resolve(signedIn ? userA : null),
    });
    const failing = () => {
      signedIn = false;
      return Promise.reject(new ApiError(401));
    };
    function Expiring() {
      useQuery({ queryKey: ['expiring'], queryFn: failing });
      return <span>protected</span>;
    }
    const expiringRoutes = routes.map((r) =>
      r.children
        ? { ...r, children: [...r.children, { path: '/expiring', element: <Expiring /> }] }
        : r,
    );
    const { router, queryClient } = renderRoutes(expiringRoutes, auth, '/expiring');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(queryClient.getQueryData(['expiring'])).toBeUndefined();
  });
});
