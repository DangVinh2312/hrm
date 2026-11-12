import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// The default 1 s of findBy* is shorter than a first render when the whole suite shares the machine;
// it stays below the 5 s test timeout so a missing element still fails with the query's own message.
configure({ asyncUtilTimeout: 4000 });

// jsdom lacks these browser APIs; Mantine's Vitest guide mocks them the same way.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});
class ResizeObserverStub {
  observe() {}

  unobserve() {}

  disconnect() {}
}
window.ResizeObserver = ResizeObserverStub;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;

afterEach(() => cleanup());
