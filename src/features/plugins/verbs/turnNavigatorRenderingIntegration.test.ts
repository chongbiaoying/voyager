import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StarredMessage } from '@/pages/content/timeline/starredTypes';

import { PluginScope } from '../runtime/pluginScope';
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

describe('ChatGPT timeline rendering stability', () => {
  let scope: PluginScope;
  let navigator: TurnNavigator;
  let main: HTMLElement;
  const nativeId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const dots = () => [...document.querySelectorAll<HTMLButtonElement>('.timeline-dot')];
  const bar = () => document.querySelector<HTMLElement>('[data-gv-turn-navigator]')!;
  async function settle() {
    await vi.advanceTimersByTimeAsync(150);
  }
  function add(n: number, text = `Question ${n}`) {
    const shell = document.createElement('div');
    shell.dataset.turnKey = nativeId(n);
    const bubble = document.createElement('div');
    bubble.dataset.userMessageBubble = '';
    bubble.textContent = text;
    shell.append(bubble);
    main.append(shell);
    return shell;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    history.replaceState({}, '', '/c/rendering');
    document.body.innerHTML = '<main></main>';
    main = document.querySelector('main')!;
    scope = new PluginScope();
    navigator = new TurnNavigator(scope, config);
    loadStars.mockResolvedValue([]);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });
  afterEach(async () => {
    await scope.dispose();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it('hides all timeline surfaces on the empty home page and reveals the first prompt', async () => {
    history.replaceState({}, '', '/');
    await navigator.start({ compactView: true });
    expect(bar().hidden).toBe(true);
    expect(
      document.querySelector<HTMLElement>('.timeline-preview-panel')?.classList.contains('visible'),
    ).toBe(false);
    add(1);
    await settle();
    expect(bar().hidden).toBe(false);
    expect(dots()).toHaveLength(1);
  });
  it('keeps native identities and button objects through twenty display-mode switches', async () => {
    add(1, 'Continue');
    add(2, 'Continue');
    await navigator.start({ compactView: true });
    const initial = dots();
    expect(bar().classList.contains('timeline-no-container')).toBe(true);
    expect(document.querySelector('.timeline-track')?.hasAttribute('aria-hidden')).toBe(false);
    for (let i = 0; i < 20; i++) {
      navigator.updateSettings({ compactView: i % 2 === 0 });
      expect(bar().classList.contains('timeline-no-container')).toBe(i % 2 === 0);
      expect(dots()).toEqual(initial);
      expect(dots()[0]).toBe(initial[0]);
      expect(dots()[1]).toBe(initial[1]);
    }
    expect(dots().map((x) => x.dataset.targetTurnId)).toEqual([
      `cg-${nativeId(1)}`,
      `cg-${nativeId(2)}`,
    ]);
  });
  it('updates edited summaries and hides/restores current branch membership', async () => {
    const first = add(1, 'Before');
    const second = add(2, 'Continue');
    await navigator.start();
    first.firstElementChild!.textContent = 'After';
    await settle();
    expect(dots()[0].getAttribute('aria-label')).toBe('After');
    second.remove();
    const alternative = add(3, 'Continue');
    await settle();
    expect(dots().map((x) => x.dataset.targetTurnId)).toEqual([
      `cg-${nativeId(1)}`,
      `cg-${nativeId(3)}`,
    ]);
    alternative.remove();
    main.append(second);
    await settle();
    expect(dots().map((x) => x.dataset.targetTurnId)).toEqual([
      `cg-${nativeId(1)}`,
      `cg-${nativeId(2)}`,
    ]);
  });
  it('retains discovered summaries for unmounted native shells without inventing unknown nodes', async () => {
    const known = add(1, 'Known');
    await navigator.start();
    known.replaceChildren();
    const unknown = document.createElement('div');
    unknown.dataset.turnKey = nativeId(2);
    main.append(unknown);
    await settle();
    expect(dots()).toHaveLength(1);
    expect(dots()[0].getAttribute('aria-label')).toBe('Known');
  });
  it('appends to five hundred prompts without replacing existing buttons and removes owned UI on stop', async () => {
    for (let i = 1; i <= 500; i++) add(i);
    await navigator.start({ compactView: true });
    const initial = dots();
    expect(initial).toHaveLength(500);
    expect(
      initial.filter((dot) => !dot.classList.contains('gv-timeline-density-hidden')).length,
    ).toBeLessThan(101);
    expect(initial.every((dot) => dot.tabIndex === 0)).toBe(true);
    add(501);
    await settle();
    expect(dots()).toHaveLength(501);
    expect(
      dots()
        .slice(0, 500)
        .every((dot, i) => dot === initial[i]),
    ).toBe(true);
    await scope.dispose();
    expect(document.querySelector('[data-gv-turn-navigator]')).toBeNull();
    expect(document.querySelector('.timeline-preview-panel')).toBeNull();
    expect(document.querySelector('[data-gv-turn-owner]')).toBeNull();
  });
  it('updates native identity when a branch swaps attributes without changing text or children', async () => {
    const shell = add(1, 'Continue');
    await navigator.start();
    shell.dataset.turnKey = nativeId(2);
    await settle();
    expect(dots().map((x) => x.dataset.targetTurnId)).toEqual([`cg-${nativeId(2)}`]);
  });
});
