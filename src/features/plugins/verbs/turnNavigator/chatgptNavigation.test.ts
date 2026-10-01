import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginScope } from '../../runtime/pluginScope';
import {
  ChatGptNavigationController,
  type ChatGptNavigationActions,
  type ChatGptNavigationTarget,
} from './chatgptNavigation';

const VIEWPORT_TOP = 100;
const VIEWPORT_HEIGHT = 600;
const CONTENT_HEIGHT = 4000;

describe('ChatGPT navigation requests', () => {
  let scope: PluginScope;
  let controller: ChatGptNavigationController;
  let scroller: HTMLElement;
  let root: HTMLElement;
  let currentSession: string;
  let targets: Map<string, ChatGptNavigationTarget>;
  let state: ReturnType<typeof vi.fn<ChatGptNavigationActions['state']>>;

  function addTurn(id: string, contentTop = 900, height = 40, mounted = true): HTMLElement {
    const element = document.createElement('div');
    element.textContent = id;
    element.getBoundingClientRect = () =>
      new DOMRect(0, VIEWPORT_TOP + contentTop - scroller.scrollTop, 500, height);
    root.appendChild(element);
    targets.set(id, { element, mounted, root });
    return element;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    document.body.innerHTML =
      '<main><div class="thread-viewport"><div class="thread"></div></div></main>';
    scroller = document.querySelector<HTMLElement>('.thread-viewport')!;
    root = document.querySelector<HTMLElement>('.thread')!;
    scroller.style.overflowY = 'auto';
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: VIEWPORT_HEIGHT },
      scrollHeight: { configurable: true, value: CONTENT_HEIGHT },
    });
    scroller.getBoundingClientRect = () => new DOMRect(0, VIEWPORT_TOP, 500, VIEWPORT_HEIGHT);
    scroller.scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
      const top = typeof options === 'number' ? (y ?? 0) : (options?.top ?? scroller.scrollTop);
      scroller.scrollTop = Math.max(0, Math.min(CONTENT_HEIGHT - VIEWPORT_HEIGHT, top));
    });
    targets = new Map();
    currentSession = 'conversation-A';
    state = vi.fn<ChatGptNavigationActions['state']>();
    scope = new PluginScope();
    controller = new ChatGptNavigationController(scope, {
      resolve: (id) => targets.get(id) ?? null,
      scrollTarget: () => scroller,
      isCurrent: (session) => session === currentSession,
      state,
    });
  });

  afterEach(async () => {
    await scope.dispose();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lets the last click finish without an older request scrolling or reporting success later', async () => {
    addTurn('first', 900);
    const latest = addTurn('latest', 1600);
    controller.start('first', currentSession);
    await vi.advanceTimersByTimeAsync(80);
    controller.start('latest', currentSession);
    await vi.advanceTimersByTimeAsync(400);

    expect(state).toHaveBeenCalledWith('cancelled', 'first');
    expect(state).not.toHaveBeenCalledWith('success', 'first');
    expect(state).toHaveBeenCalledWith('success', 'latest');
    expect(latest.getBoundingClientRect().top + 20 - VIEWPORT_TOP).toBe(VIEWPORT_HEIGHT * 0.45);
    const calls = vi.mocked(scroller.scrollTo).mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(vi.mocked(scroller.scrollTo).mock.calls).toHaveLength(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports an unmounted target unavailable once after the three-second limit', async () => {
    addTurn('shell', 900, 40, false);
    controller.start('shell', currentSession);
    await vi.advanceTimersByTimeAsync(2999);
    expect(state).not.toHaveBeenCalledWith('unavailable', 'shell');
    await vi.advanceTimersByTimeAsync(81);
    expect(state.mock.calls.filter(([status]) => status === 'unavailable')).toEqual([
      ['unavailable', 'shell'],
    ]);
    const calls = vi.mocked(scroller.scrollTo).mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(state.mock.calls.filter(([status]) => status === 'unavailable')).toHaveLength(1);
    expect(vi.mocked(scroller.scrollTo).mock.calls).toHaveLength(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows preview scrolling but cancels when the reader wheels the conversation', async () => {
    const target = addTurn('shell', 900, 40, false);
    const preview = document.createElement('div');
    preview.className = 'timeline-preview-panel';
    root.appendChild(preview);
    controller.start('shell', currentSession);
    preview.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }));
    await vi.advanceTimersByTimeAsync(160);
    expect(state).not.toHaveBeenCalledWith('cancelled', 'shell');

    target.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    expect(state.mock.calls.filter(([status]) => status === 'cancelled')).toEqual([
      ['cancelled', 'shell'],
    ]);
    const calls = vi.mocked(scroller.scrollTo).mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    target.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }));
    expect(state.mock.calls.filter(([status]) => status === 'cancelled')).toHaveLength(1);
    expect(state).not.toHaveBeenCalledWith('unavailable', 'shell');
    expect(vi.mocked(scroller.scrollTo).mock.calls).toHaveLength(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('positions a long question by its top with a 32px viewport inset', async () => {
    const target = addTurn('long-question', 900, 1200);
    controller.start('long-question', currentSession);
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 868, behavior: 'smooth' });
    expect(target.getBoundingClientRect().top - VIEWPORT_TOP).toBe(32);
    await vi.advanceTimersByTimeAsync(400);
    expect(state).toHaveBeenCalledWith('success', 'long-question');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels polling when its conversation session expires', async () => {
    addTurn('shell', 900, 40, false);
    controller.start('shell', currentSession);
    currentSession = 'conversation-B';
    await vi.advanceTimersByTimeAsync(80);
    expect(state).toHaveBeenCalledWith('cancelled', 'shell');
    const calls = vi.mocked(scroller.scrollTo).mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(vi.mocked(scroller.scrollTo).mock.calls).toHaveLength(calls);
    expect(state).not.toHaveBeenCalledWith('success', 'shell');
    expect(state).not.toHaveBeenCalledWith('unavailable', 'shell');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the current conversation root to cancel after a DOM replacement', async () => {
    addTurn('shell', 900, 40, false);
    controller.start('shell', currentSession);
    const replacement = document.createElement('div');
    root.replaceWith(replacement);
    root = replacement;
    const replacementTurn = addTurn('shell', 900, 40, false);
    await vi.advanceTimersByTimeAsync(80);
    replacementTurn.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    expect(state).toHaveBeenCalledWith('cancelled', 'shell');
    await vi.advanceTimersByTimeAsync(4000);
    expect(state).not.toHaveBeenCalledWith('unavailable', 'shell');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also cancels a wheel on the current viewport outside its inner transcript root', async () => {
    addTurn('shell', 900, 40, false);
    controller.start('shell', currentSession);
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    expect(state).toHaveBeenCalledWith('cancelled', 'shell');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finishes a shell navigation once its message mounts and stops on plugin teardown', async () => {
    addTurn('shell', 900, 40, false);
    controller.start('shell', currentSession);
    await vi.advanceTimersByTimeAsync(160);
    targets.get('shell')!.mounted = true;
    await vi.advanceTimersByTimeAsync(160);
    expect(state).toHaveBeenCalledWith('success', 'shell');
    addTurn('another-shell', 1600, 40, false);
    controller.start('another-shell', currentSession);
    await scope.dispose();
    const calls = vi.mocked(scroller.scrollTo).mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(vi.mocked(scroller.scrollTo).mock.calls).toHaveLength(calls);
    expect(state).not.toHaveBeenCalledWith('unavailable', 'another-shell');
    expect(vi.getTimerCount()).toBe(0);
  });
});
