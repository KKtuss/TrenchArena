import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __showdownRuntimeForTest } from '../components/showdown-battle';

test('Showdown runtime is shared across remounts and cleaned after final unmount', async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalCSS = globalThis.CSS;
  const elements: Array<{
    dataset: Record<string, string>;
    listeners: Record<string, () => void>;
    remove: () => void;
  }> = [];

  const fakeWindow = {
    location: { host: 'localhost:3001', protocol: 'http:', hostname: 'localhost', port: '3001' },
  } as unknown as Window & typeof globalThis;
  const fakeDocument = {
    head: {
      appendChild(element: typeof elements[number]) {
        elements.push(element);
        queueMicrotask(() => element.listeners.load?.());
      },
    },
    createElement() {
      const element = {
        dataset: {},
        listeners: {} as Record<string, () => void>,
        addEventListener(type: string, listener: () => void) {
          element.listeners[type] = listener;
        },
        remove() {
          const index = elements.indexOf(element);
          if (index >= 0) elements.splice(index, 1);
        },
      };
      return element;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [...elements];
    },
  } as unknown as Document;

  Object.assign(globalThis, {
    window: fakeWindow,
    document: fakeDocument,
    CSS: { escape: (value: string) => value },
  });

  try {
    const first = __showdownRuntimeForTest.acquire();
    const second = __showdownRuntimeForTest.acquire();
    await Promise.all([first, second]);
    assert.equal(elements.length, __showdownRuntimeForTest.assetCount);

    __showdownRuntimeForTest.release();
    await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(elements.length, __showdownRuntimeForTest.assetCount);

    __showdownRuntimeForTest.release();
    await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(elements.length, 0);
  } finally {
    Object.assign(globalThis, {
      window: originalWindow,
      document: originalDocument,
      CSS: originalCSS,
    });
  }
});
