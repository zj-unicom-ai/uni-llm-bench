import '@testing-library/jest-dom';
import { vi } from 'vitest';

/**
 * jsdom gaps that antd needs.
 *
 * Several components (Table with `scroll`, Grid/useBreakpoint) reach for
 * ResizeObserver and matchMedia, neither of which jsdom implements. Without
 * these shims any test that renders real antd components dies on an unrelated
 * environment error, which pushes tests toward mocking antd out entirely and
 * losing the value of rendering it.
 */

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  } as unknown as typeof ResizeObserver;
}

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })) as unknown as typeof window.matchMedia;
}
