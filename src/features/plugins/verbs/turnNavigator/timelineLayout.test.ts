import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginScope } from '../../runtime/pluginScope';
import { TimelineLayoutObserver } from './timelineLayout';

let notify: () => void;
const observe = vi.fn(),
  unobserve = vi.fn(),
  disconnect = vi.fn();
beforeEach(() => {
  document.body.innerHTML =
    '<main><div class="thread-scroll-container"><div data-thread-find-target="conversation"><div id="shell"><div id="bubble">Prompt</div></div></div></div></main>';
  observe.mockClear();
  unobserve.mockClear();
  disconnect.mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
    },
  );
});
afterEach(() => vi.unstubAllGlobals());
describe('timeline content layout observation', () => {
  it('observes growing conversation content and prompt/shell inside a fixed viewport', async () => {
    const scope = new PluginScope(),
      update = vi.fn();
    const owner = new TimelineLayoutObserver(scope, document.querySelector('main')!, update);
    const element = document.querySelector<HTMLElement>('#bubble')!,
      shell = document.querySelector<HTMLElement>('#shell')!;
    owner.update([{ element, shell }]);
    expect(observe).toHaveBeenCalledWith(element);
    expect(observe).toHaveBeenCalledWith(shell);
    expect(observe).toHaveBeenCalledWith(document.querySelector('[data-thread-find-target]'));
    notify();
    expect(update).toHaveBeenCalledTimes(1);
    await scope.dispose();
    notify();
    expect(update).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(scope.getEffects()).toHaveLength(0);
  });
  it('updates appended targets and releases retired branch elements without duplicate observation', async () => {
    const scope = new PluginScope(),
      owner = new TimelineLayoutObserver(scope, document.querySelector('main')!, vi.fn());
    const old = document.querySelector<HTMLElement>('#bubble')!;
    owner.update([{ element: old }]);
    const count = observe.mock.calls.length;
    owner.update([{ element: old }]);
    expect(observe).toHaveBeenCalledTimes(count);
    const next = document.createElement('div');
    old.replaceWith(next);
    owner.update([{ element: next }]);
    expect(unobserve).toHaveBeenCalledWith(old);
    expect(observe).toHaveBeenCalledWith(next);
    await scope.dispose();
  });
});
