import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import {
  isErrorMessageKey,
  isMessageKey,
  readStoredLocale,
  storeLocale,
} from '../src/i18n/i18n.helper';
import { ApiError } from '../src/infrastructure/http.client';
import { fakeAuth, renderRoutes } from './render.helper';

afterEach(() => {
  document.documentElement.lang = 'vi';
});

describe('locale', () => {
  it('switches the whole page to English and remembers the choice', async () => {
    const storage = { setItem: vi.fn() };
    renderRoutes(routes, fakeAuth(), '/login', { storage });
    expect(await screen.findByRole('heading', { name: 'Đăng nhập' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Ngôn ngữ' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'English' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Language' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
    expect(storage.setItem).toHaveBeenCalledWith('hrm.locale', 'en');
  });

  it('shows the API error key in the current language', async () => {
    renderRoutes(
      routes,
      fakeAuth({ beginLogin: () => Promise.reject(new ApiError(403, 'error.accessDenied')) }),
      '/login',
      { locale: 'en' },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    expect(await screen.findByText('Could not start sign-in')).toBeInTheDocument();
    expect(screen.getByText(/This action could not be completed/)).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
  });

  it('reads only a known stored locale and survives blocked storage', () => {
    const stored = (value: string | null) => ({ getItem: () => value });
    expect(readStoredLocale(stored('en'))).toBe('en');
    for (const value of [null, '', 'fr', 'EN', 'vi-VN'])
      expect(readStoredLocale(stored(value))).toBe('vi');
    const blocked = {
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    };
    expect(readStoredLocale(blocked)).toBe('vi');
    expect(readStoredLocale(undefined)).toBe('vi');
    expect(() => storeLocale(blocked, 'en')).not.toThrow();
  });

  it('accepts only keys of its own dictionary as API error keys', () => {
    expect(isErrorMessageKey('error.notFound')).toBe(true);
    expect(isMessageKey('auth.login.title')).toBe(true);
    for (const value of ['auth.login.title', 'error.', 'error.toString', 'constructor', 42, null])
      expect(isErrorMessageKey(value)).toBe(false);
  });
});
