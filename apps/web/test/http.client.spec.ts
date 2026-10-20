import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ApiError,
  ResponseShapeError,
  apiErrorKey,
  createHttpClient,
} from '../src/infrastructure/http.client';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('http client', () => {
  it('sends GET same-origin without a CSRF token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json({ ok: true })));
    const http = createHttpClient(fetchImpl);
    await expect(http.request('/api/x', z.object({ ok: z.boolean() }))).resolves.toEqual({
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe('/api/x');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.headers).not.toHaveProperty('x-csrf-token');
  });

  it('sends the extra headers of the call next to the CSRF token', async () => {
    const fetchImpl = vi.fn<typeof fetch>((path) =>
      Promise.resolve(path === '/api/auth/csrf' ? json({ csrfToken: 't' }) : json({})),
    );
    await createHttpClient(fetchImpl).request('/api/a', z.object({}), {
      method: 'POST',
      body: {},
      headers: { 'idempotency-key': 'k' },
    });
    expect(fetchImpl.mock.calls[1]![1]?.headers).toMatchObject({
      'idempotency-key': 'k',
      'x-csrf-token': 't',
    });
  });

  it('cannot override the CSRF token or content type through call headers, in any letter case', async () => {
    const fetchImpl = vi.fn<typeof fetch>((path) =>
      Promise.resolve(path === '/api/auth/csrf' ? json({ csrfToken: 'real' }) : json({})),
    );
    await createHttpClient(fetchImpl).request('/api/a', z.object({}), {
      method: 'POST',
      body: {},
      headers: { 'X-CSRF-Token': 'forged', 'Content-Type': 'text/plain', 'Idempotency-Key': 'k' },
    });
    const headers = fetchImpl.mock.calls[1]![1]?.headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('real');
    expect(headers['content-type']).toBe('application/json');
    expect(Object.keys(headers).filter((name) => /^x-csrf-token$/i.test(name))).toHaveLength(1);
    expect(headers['idempotency-key']).toBe('k');
  });

  it('fetches a CSRF token before a mutation and reuses it until refresh', async () => {
    let time = 0;
    const fetchImpl = vi.fn<typeof fetch>((path) =>
      Promise.resolve(path === '/api/auth/csrf' ? json({ csrfToken: `t${time}` }) : json({})),
    );
    const http = createHttpClient(fetchImpl, () => time);
    await http.request('/api/a', z.object({}), { method: 'POST', body: { a: 1 } });
    await http.request('/api/b', z.object({}), { method: 'POST', body: { b: 2 } });
    time = 31 * 60 * 1000;
    await http.request('/api/c', z.object({}), { method: 'POST' });
    const calls = fetchImpl.mock.calls.map(([path, init]) => [
      path,
      (init?.headers as Record<string, string>)['x-csrf-token'],
    ]);
    expect(calls).toEqual([
      ['/api/auth/csrf', undefined],
      ['/api/a', 't0'],
      ['/api/b', 't0'],
      ['/api/auth/csrf', undefined],
      ['/api/c', `t${31 * 60 * 1000}`],
    ]);
    expect(fetchImpl.mock.calls[1]![1]?.body).toBe('{"a":1}');
  });

  it('never retries a failed mutation and drops the token on reset', async () => {
    const fetchImpl = vi.fn<typeof fetch>((path) =>
      Promise.resolve(path === '/api/auth/csrf' ? json({ csrfToken: 't' }) : json({}, 503)),
    );
    const http = createHttpClient(fetchImpl);
    await expect(http.request('/api/a', z.object({}), { method: 'POST' })).rejects.toMatchObject({
      status: 503,
    });
    expect(fetchImpl.mock.calls.filter(([p]) => p === '/api/a')).toHaveLength(1);
    http.reset();
    await http.request('/api/auth/session', z.object({}), {}).catch(() => undefined);
    await http.request('/api/b', z.object({}), { method: 'POST' }).catch(() => undefined);
    expect(fetchImpl.mock.calls.filter(([p]) => p === '/api/auth/csrf')).toHaveLength(2);
  });

  it('rejects non-2xx, wrong shapes and paths outside /api', async () => {
    const http = createHttpClient(() => Promise.resolve(json({ message: 'secret detail' }, 403)));
    const error = await http.request('/api/x', z.object({})).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).not.toContain('secret detail');
    const shape = createHttpClient(() => Promise.resolve(json({ userId: 5 })));
    await expect(shape.request('/api/x', z.object({ userId: z.string() }))).rejects.toBeInstanceOf(
      ResponseShapeError,
    );
    await expect(shape.request('https://evil.test/api/x', z.object({}))).rejects.toThrow(TypeError);
    await expect(shape.request('/auth/session', z.object({}))).rejects.toThrow(TypeError);
  });

  it('keeps only a known error key from the body and falls back otherwise', async () => {
    const failure = (body: BodyInit | null, status = 409) =>
      createHttpClient(() => Promise.resolve(new Response(body, { status })))
        .request('/api/x', z.object({}))
        .catch((e: unknown) => e);

    expect(
      await failure(JSON.stringify({ statusCode: 409, code: 'error.conflict' })),
    ).toMatchObject({ status: 409, code: 'error.conflict' });
    for (const body of [
      JSON.stringify({ code: 'Access denied for person@example.test' }),
      JSON.stringify({ code: 'auth.login.title' }),
      JSON.stringify({ code: 'error.notAKey' }),
      JSON.stringify({ code: '__proto__' }),
      JSON.stringify({ message: 'secret detail' }),
      '<html>Bad gateway</html>',
      null,
    ])
      expect(await failure(body, 502)).toMatchObject({ status: 502, code: 'error.unavailable' });
    expect(apiErrorKey(new TypeError('Failed to fetch'))).toBe('error.unavailable');
  });

  it('passes the abort signal to fetch', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>((_path, init) =>
      init?.signal?.aborted
        ? Promise.reject(new DOMException('aborted', 'AbortError'))
        : Promise.resolve(json({})),
    );
    controller.abort();
    await expect(
      createHttpClient(fetchImpl).request('/api/x', z.object({}), { signal: controller.signal }),
    ).rejects.toThrow('aborted');
  });
});
