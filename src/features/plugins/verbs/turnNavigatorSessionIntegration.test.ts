import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { StarredMessage } from '@/pages/content/timeline/starredTypes';

import { PluginScope } from '../runtime/pluginScope';
import { ChatGptTimelineProvider } from '../sites/adapters/chatgptTurns';
import { TurnNavigator, type TurnNavigatorConfig } from './turnNavigator/TurnNavigator';

const { loadStars, addStar, removeStar } = vi.hoisted(() => ({
  loadStars: vi.fn<(id: string) => Promise<StarredMessage[]>>().mockResolvedValue([]),
  addStar: vi.fn().mockResolvedValue(undefined),
  removeStar: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/utils/i18n', () => ({
  initI18n: vi.fn().mockResolvedValue(undefined),
  getTranslationSync: (key: string) => key,
}));
vi.mock('@/pages/content/timeline/StarredMessagesService', () => ({
  StarredMessagesService: {
    getStarredMessagesForConversation: loadStars,
    addStarredMessage: addStar,
    removeStarredMessage: removeStar,
  },
}));
vi.mock('@/features/plugins/storage/pluginState', () => ({
  setPluginSetting: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/pages/content/timeline/timelineStyleCoachmark', () => ({
  showTimelineStyleCoachmark: vi.fn().mockResolvedValue(undefined),
}));

const config: TurnNavigatorConfig = {
  siteId: 'chatgpt',
  siteLabel: 'ChatGPT',
  turnSelector: '[data-user-message-bubble]',
  conversationIdPattern: '^(?:/u/[^/]+)?(?:/g/[^/]+)?/c/([^/?#]+)',
  position: 'right',
  pluginId: 'voyager.chatgpt-timeline',
  coachmarkId: 'test-timeline-style',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

function starred(conversation: string, turnId: string, content: string): StarredMessage {
  return {
    turnId: `cg-${turnId}`,
    content,
    conversationId: `chatgpt:conv:${conversation}`,
    conversationUrl: `${location.origin}/c/${conversation}`,
    conversationTitle: conversation,
    starredAt: 1,
  };
}

describe('ChatGPT timeline manager conversation sessions', () => {
  let scope: PluginScope;
  let scroller: HTMLElement;
  let navigator: TurnNavigator;

  async function flush(): Promise<void> {
    for (let index = 0; index < 6; index++) await Promise.resolve();
  }

  async function settle(milliseconds = 150): Promise<void> {
    await vi.advanceTimersByTimeAsync(milliseconds);
  }

  function dots(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('.timeline-dot'));
  }

  function bar(): HTMLElement {
    return document.querySelector<HTMLElement>('[data-gv-turn-navigator="chatgpt"]')!;
  }

  function route(path: string): void {
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  function renderConversation(
    conversation: string | null,
    turns: Array<{ id: string; text: string }>,
  ): HTMLElement {
    const root = document.createElement('div');
    if (conversation) root.dataset.turnIdContainer = `paginated-root:${conversation}`;
    for (const [index, { id, text }] of turns.entries()) {
      const shell = document.createElement('div');
      shell.dataset.turnIdContainer = id;
      shell.dataset.turn = 'user';
      const bubble = document.createElement('div');
      bubble.dataset.userMessageBubble = '';
      bubble.textContent = text;
      bubble.getBoundingClientRect = () =>
        ({
          top: index * 200 - scroller.scrollTop,
          bottom: index * 200 + 40 - scroller.scrollTop,
          height: 40,
        }) as DOMRect;
      shell.appendChild(bubble);
      root.appendChild(shell);
    }
    scroller.replaceChildren(root);
    return root;
  }

  async function mount(): Promise<void> {
    navigator = new TurnNavigator(scope, config);
    await navigator.start();
    await flush();
  }

  function storageNotice(): void {
    const calls = vi.mocked(chrome.storage.onChanged.addListener).mock.calls;
    const listener = calls[calls.length - 1][0];
    listener({ [StorageKeys.TIMELINE_STARRED_MESSAGES]: { newValue: [] } }, 'local');
  }

  async function longPress(dot: HTMLButtonElement): Promise<void> {
    dot.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle(550);
    dot.dispatchEvent(new Event('pointerup', { bubbles: true }));
    await flush();
  }

  function openPreview(): { panel: HTMLElement; input: HTMLInputElement; list: HTMLElement } {
    document.querySelector<HTMLButtonElement>('.timeline-preview-toggle')!.click();
    return {
      panel: document.querySelector<HTMLElement>('.timeline-preview-panel')!,
      input: document.querySelector<HTMLInputElement>('.timeline-preview-search input')!,
      list: document.querySelector<HTMLElement>('.timeline-preview-list')!,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    const stored = new Map<string, StarredMessage[]>();
    loadStars.mockReset().mockImplementation(async (id) => stored.get(id) ?? []);
    addStar.mockReset().mockImplementation(async (message: StarredMessage) => {
      const records = stored.get(message.conversationId) ?? [];
      stored.set(message.conversationId, [
        ...records.filter((record) => record.turnId !== message.turnId),
        message,
      ]);
    });
    removeStar.mockReset().mockImplementation(async (id: string, turnId: string) => {
      stored.set(
        id,
        (stored.get(id) ?? []).filter((record) => record.turnId !== turnId),
      );
    });
    vi.mocked(chrome.storage.onChanged.addListener).mockClear();
    history.replaceState({}, '', '/c/A');
    document.body.innerHTML = '<main></main>';
    scroller = document.querySelector<HTMLElement>('main')!;
    scroller.style.overflowY = 'auto';
    Object.defineProperties(scroller, {
      clientHeight: { value: 600 },
      scrollHeight: { value: 6000 },
    });
    scroller.scrollTo = vi.fn();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    scope = new PluginScope();
  });

  afterEach(async () => {
    await scope.dispose();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('hides old markers and resets the preview when the route changes before the DOM', async () => {
    renderConversation('A', [{ id: 'A-turn', text: 'Question A' }]);
    await mount();
    const { panel, input, list } = openPreview();
    input.value = 'Question A';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(200);
    list.scrollTop = 220;

    route('/c/B');
    expect(dots()).toHaveLength(0);
    expect(bar().hidden).toBe(true);
    expect(panel.classList.contains('visible')).toBe(false);
    expect(input.value).toBe('');
    expect(list.scrollTop).toBe(0);
    await settle();
    expect(dots()).toHaveLength(0);

    renderConversation('B', [{ id: 'B-turn', text: 'Question B' }]);
    await settle();
    expect(dots().map((dot) => dot.getAttribute('aria-label'))).toEqual(['Question B']);
    expect(bar().hidden).toBe(false);
  });

  it('does not lose the queued DOM refresh when storage notices a new route first', async () => {
    renderConversation('A', [{ id: 'A-turn', text: 'Question A' }]);
    await mount();
    history.pushState({}, '', '/c/B');
    renderConversation('B', [{ id: 'B-turn', text: 'Question B' }]);
    await flush();
    storageNotice();
    await settle(600);
    expect(dots().map((dot) => dot.getAttribute('aria-label'))).toEqual(['Question B']);
    expect(bar().hidden).toBe(false);
  });

  it('ignores an old conversation read that resolves after the current conversation read', async () => {
    renderConversation('A', [{ id: 'A-turn', text: 'Question A' }]);
    await mount();
    const oldRead = deferred<StarredMessage[]>();
    loadStars.mockImplementationOnce(() => oldRead.promise);
    storageNotice();
    loadStars.mockResolvedValue([starred('B', 'B-turn', 'Question B')]);
    route('/c/B');
    renderConversation('B', [{ id: 'B-turn', text: 'Question B' }]);
    await settle();
    expect(loadStars).toHaveBeenLastCalledWith('chatgpt:conv:B');
    expect(dots()[0].getAttribute('aria-pressed')).toBe('true');

    oldRead.resolve([]);
    await flush();
    expect(dots().map((dot) => dot.getAttribute('aria-label'))).toEqual(['Question B']);
    expect(dots()[0].getAttribute('aria-pressed')).toBe('true');
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });

  it('rejects a stale read after navigating A to B and back to A', async () => {
    renderConversation('A', [{ id: 'A-turn', text: 'Question A' }]);
    await mount();
    const firstA = deferred<StarredMessage[]>();
    loadStars.mockImplementationOnce(() => firstA.promise);
    storageNotice();
    route('/c/B');
    renderConversation('B', [{ id: 'B-turn', text: 'Question B' }]);
    await settle();
    loadStars.mockResolvedValue([starred('A', 'A-turn', 'Question A')]);
    route('/c/A');
    renderConversation('A', [{ id: 'A-turn', text: 'Question A' }]);
    await settle();
    expect(dots()[0].getAttribute('aria-pressed')).toBe('true');

    firstA.resolve([]);
    await flush();
    expect(dots()[0].getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps reading position, active turn and preview browsing during cross-window star notices', async () => {
    renderConversation(
      'A',
      Array.from({ length: 180 }, (_, index) => ({ id: `A-${index}`, text: `Question ${index}` })),
    );
    await mount();
    scroller.scrollTop = 800;
    scroller.dispatchEvent(new Event('scroll'));
    await settle(20);
    const active = document
      .querySelector('.timeline-dot.active')
      ?.getAttribute('data-target-turn-id');
    const { panel, input, list } = openPreview();
    input.value = 'Question';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(200);
    list.scrollTop = 420;
    list.dispatchEvent(new Event('scroll'));
    await settle(20);
    loadStars.mockResolvedValue([starred('A', 'A-3', 'Question 3')]);

    storageNotice();
    await flush();
    expect(panel.classList.contains('visible')).toBe(true);
    expect(input.value).toBe('Question');
    expect(list.scrollTop).toBe(420);
    expect(scroller.scrollTop).toBe(800);
    expect(
      document.querySelector('.timeline-dot.active')?.getAttribute('data-target-turn-id'),
    ).toBe(active);
    expect(dots()[3].getAttribute('aria-pressed')).toBe('true');
    expect(scroller.scrollTo).not.toHaveBeenCalled();
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it('persists a temporary star once after a matching formal conversation root confirms ownership', async () => {
    history.replaceState({}, '', '/');
    renderConversation(null, [{ id: 'new-turn', text: 'New question' }]);
    await mount();
    await longPress(dots()[0]);
    expect(dots()[0].getAttribute('aria-pressed')).toBe('true');
    expect(addStar).not.toHaveBeenCalled();

    const oldFormalRead = deferred<StarredMessage[]>();
    loadStars.mockImplementationOnce(() => oldFormalRead.promise);
    route('/c/created');
    renderConversation('created', [{ id: 'new-turn', text: 'New question' }]);
    await settle();
    expect(addStar).toHaveBeenCalledTimes(1);
    expect(addStar).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 'cg-new-turn',
        conversationId: 'chatgpt:conv:created',
        conversationUrl: `${location.origin}/c/created`,
      }),
    );
    expect(dots()[0].getAttribute('aria-pressed')).toBe('true');
    oldFormalRead.resolve([]);
    await flush();
    expect(dots()[0].getAttribute('aria-pressed')).toBe('true');
    scroller.appendChild(document.createElement('span'));
    await settle();
    expect(addStar).toHaveBeenCalledTimes(1);
  });

  it('does not promote temporary stars merely because an old formal route opens above stale DOM', async () => {
    history.replaceState({}, '', '/');
    renderConversation(null, [{ id: 'temp-turn', text: 'Temporary question' }]);
    await mount();
    await longPress(dots()[0]);
    route('/c/old');
    await settle();
    expect(dots()).toHaveLength(0);
    expect(bar().hidden).toBe(true);
    expect(addStar).not.toHaveBeenCalled();

    renderConversation('old', [{ id: 'old-turn', text: 'Old question' }]);
    await settle();
    expect(dots().map((dot) => dot.getAttribute('aria-label'))).toEqual(['Old question']);
    expect(dots()[0].getAttribute('aria-pressed')).toBe('false');
    expect(addStar).not.toHaveBeenCalled();
  });

  it('cancels an old conversation long press before it can write stars into the next chat', async () => {
    renderConversation('A', [{ id: 'A-turn', text: 'Question A' }]);
    await mount();
    dots()[0].dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle(300);
    route('/c/B');
    renderConversation('B', [{ id: 'B-turn', text: 'Question B' }]);
    await settle(600);
    expect(addStar).not.toHaveBeenCalled();
    expect(dots()[0].getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps a newly toggled star when an older initial storage snapshot arrives afterwards', async () => {
    const initialRead = deferred<StarredMessage[]>();
    loadStars.mockImplementationOnce(() => initialRead.promise);
    renderConversation('A', [{ id: 'A-turn', text: 'Question A' }]);
    await mount();
    await longPress(dots()[0]);
    expect(addStar).toHaveBeenCalledTimes(1);
    expect(dots()[0].getAttribute('aria-pressed')).toBe('true');

    initialRead.resolve([]);
    await flush();
    expect(dots()[0].getAttribute('aria-pressed')).toBe('true');
  });

  it('can unstar a page-local fallback turn on a formal route without persisting an unstable ID', async () => {
    renderConversation('A', []);
    const shell = document.createElement('div');
    const bubble = document.createElement('div');
    bubble.dataset.userMessageBubble = '';
    bubble.textContent = 'Page-local question';
    shell.appendChild(bubble);
    scroller.firstElementChild!.appendChild(shell);
    await mount();

    await longPress(dots()[0]);
    expect(dots()[0].getAttribute('aria-pressed')).toBe('true');
    await longPress(dots()[0]);
    expect(dots()[0].getAttribute('aria-pressed')).toBe('false');
    expect(addStar).not.toHaveBeenCalled();
    expect(removeStar).not.toHaveBeenCalled();
  });

  it('does not apply an old conversation write completion to the next conversation', async () => {
    const oldWrite = deferred<void>();
    addStar.mockImplementationOnce(() => oldWrite.promise);
    renderConversation('A', [{ id: 'A-turn', text: 'Question A' }]);
    await mount();
    await longPress(dots()[0]);
    expect(addStar).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'chatgpt:conv:A',
        turnId: 'cg-A-turn',
      }),
    );

    route('/c/B');
    renderConversation('B', [{ id: 'B-turn', text: 'Question B' }]);
    await settle();
    oldWrite.resolve();
    await flush();
    expect(dots().map((dot) => dot.getAttribute('aria-label'))).toEqual(['Question B']);
    expect(dots()[0].getAttribute('aria-pressed')).toBe('false');
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });
  it('promotes retained modern UUID nodes and temporary stars after an evidenced first submission', async () => {
    history.replaceState({}, '', '/');
    const provider = new ChatGptTimelineProvider();
    navigator = new TurnNavigator(scope, config, provider);
    await navigator.start();
    provider.recordNewConversationSubmission('First prompt');
    const id = '11111111-1111-4111-8111-111111111111';
    scroller.innerHTML = `<div data-turn-key="${id}"><div data-user-message-bubble>First prompt</div></div>`;
    await settle();
    await longPress(dots()[0]);
    expect(addStar).not.toHaveBeenCalled();
    history.replaceState({}, '', '/c/created');
    await settle(550);
    expect(bar().hidden).toBe(false);
    expect(dots()[0].dataset.targetTurnId).toBe(`cg-${id}`);
    expect(dots()[0].getAttribute('aria-pressed')).toBe('true');
    expect(addStar).toHaveBeenCalledTimes(1);
    expect(addStar).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'chatgpt:conv:created', turnId: `cg-${id}` }),
    );
  });

  it('keeps live effects bounded across thirty conversation changes with pending jumps', async () => {
    renderConversation('A', [{ id: 'A-turn', text: 'First' }]);
    await mount();
    const initial = scope.getEffects().length;
    for (let i = 0; i < 30; i++) {
      dots()[0].click();
      route(`/c/session-${i}`);
      renderConversation(`session-${i}`, [{ id: `turn-${i}`, text: `Question ${i}` }]);
      await settle();
      expect(document.querySelectorAll('[data-gv-turn-navigator]')).toHaveLength(1);
      expect(dots()).toHaveLength(1);
      expect(scope.getEffects().length).toBeLessThanOrEqual(initial + 2);
    }
    await scope.dispose();
    expect(scope.getEffects()).toHaveLength(0);
    expect(document.querySelector('.gv-timeline-navigation-status')).toBeNull();
  });
  it('keeps the long prompt active when its start is aligned above the reading anchor', async () => {
    renderConversation('A', [
      { id: 'short', text: 'Short' },
      { id: 'long', text: 'Long prompt' },
    ]);
    const long = scroller.querySelectorAll<HTMLElement>('[data-user-message-bubble]')[1];
    long.getBoundingClientRect = () => new DOMRect(0, 200 - scroller.scrollTop, 500, 2000);
    vi.mocked(scroller.scrollTo).mockImplementation(
      (options?: ScrollToOptions | number, y?: number) => {
        scroller.scrollTop = typeof options === 'number' ? (y ?? 0) : (options?.top ?? 0);
        scroller.dispatchEvent(new Event('scroll'));
      },
    );
    await mount();
    dots()[1].click();
    await settle(600);
    expect(long.getBoundingClientRect().top).toBe(32);
    expect(dots()[1].getAttribute('aria-current')).toBe('true');
  });
});
