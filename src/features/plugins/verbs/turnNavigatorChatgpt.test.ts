import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requireBundledSiteAdapter } from '../catalog/sites';
import { PluginScope } from '../runtime/pluginScope';
import { BundledCatalogPluginSource } from '../sources/BundledCatalogPluginSource';
import { turnNavigatorPrimitive } from './turnNavigator';

const { loadStars } = vi.hoisted(() => ({ loadStars: vi.fn().mockResolvedValue([]) }));

vi.mock('@/utils/i18n', () => ({
  initI18n: vi.fn().mockResolvedValue(undefined),
  getTranslationSync: (key: string) => key,
}));
vi.mock('@/pages/content/timeline/StarredMessagesService', () => ({
  StarredMessagesService: { getStarredMessagesForConversation: loadStars },
}));
vi.mock('@/features/plugins/storage/pluginState', () => ({
  setPluginSetting: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/pages/content/timeline/timelineStyleCoachmark', () => ({
  showTimelineStyleCoachmark: vi.fn().mockResolvedValue(undefined),
}));

describe('ChatGPT catalog timeline', () => {
  let scope: PluginScope;
  let conversation: HTMLElement;

  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(150);
  }

  function addMessage(text: string, role = 'user'): HTMLElement {
    const message = document.createElement('div');
    message.dataset.messageAuthorRole = role;
    message.textContent = text;
    conversation.appendChild(message);
    return message;
  }

  function dots(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll('.timeline-dot'));
  }

  async function mount(): Promise<void> {
    const manifests = await new BundledCatalogPluginSource().list();
    const manifest = manifests.find((entry) => entry.id === 'voyager.chatgpt-timeline');
    expect(manifest).toBeDefined();
    const op = manifest!.contributes?.domOps?.find((entry) => entry.op === 'native');
    if (!op || op.op !== 'native') throw new Error('Timeline needs a native operation');
    expect(op.handler).toBe(turnNavigatorPrimitive.contract.name);
    const params = turnNavigatorPrimitive.validateParams(op.params);
    if (!params.success) throw new Error('Invalid timeline parameters');
    turnNavigatorPrimitive.activate(scope, params.data, {
      doc: document,
      adapter: requireBundledSiteAdapter('chatgpt'),
      pluginId: manifest!.id,
      settings: {},
      setTargetCounter: () => {},
    });
    await settle();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    loadStars.mockClear();
    history.replaceState({}, '', '/c/first');
    document.body.innerHTML = '<main></main>';
    conversation = document.querySelector('main')!;
    scope = new PluginScope();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });

  afterEach(async () => {
    await scope.dispose();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('indexes 60 user messages, excludes assistant messages and tracks new messages', async () => {
    for (let index = 0; index < 60; index++) {
      addMessage(`Question ${index}`);
      addMessage(`Answer ${index}`, 'assistant');
    }
    await mount();
    expect(document.querySelectorAll('[data-gv-turn-navigator="chatgpt"]')).toHaveLength(1);
    expect(dots().map((dot) => dot.getAttribute('aria-label'))).toEqual(
      Array.from({ length: 60 }, (_, index) => `Question ${index}`),
    );
    addMessage('Next question');
    await settle();
    expect(dots()).toHaveLength(61);
    expect(dots()[60].getAttribute('aria-label')).toBe('Next question');
  });

  it('scrolls the detected conversation container when a node is clicked', async () => {
    conversation.style.overflowY = 'auto';
    Object.defineProperties(conversation, {
      clientHeight: { value: 600 },
      scrollHeight: { value: 2000 },
    });
    conversation.scrollTo = vi.fn();
    const message = addMessage('Jump here');
    message.getBoundingClientRect = () => ({ top: 700, bottom: 740, height: 40 }) as DOMRect;
    await mount();
    dots()[0].click();
    expect(conversation.scrollTo).toHaveBeenCalledWith({
      top: 450,
      behavior: expect.stringMatching(/^(smooth|instant)$/),
    });
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it('replaces nodes and conversation identity after navigation with DOM replacement', async () => {
    addMessage('Old conversation');
    await mount();
    expect(loadStars).toHaveBeenLastCalledWith('chatgpt:conv:first');
    history.pushState({}, '', '/c/second');
    conversation.replaceChildren();
    addMessage('New conversation');
    await settle();
    expect(dots().map((dot) => dot.getAttribute('aria-label'))).toEqual(['New conversation']);
    expect(loadStars).toHaveBeenLastCalledWith('chatgpt:conv:second');
  });

  it('starts without message nodes on home and rebuilds once after teardown', async () => {
    history.replaceState({}, '', '/');
    await mount();
    expect(dots()).toHaveLength(0);
    history.pushState({}, '', '/c/created');
    addMessage('First message');
    await settle();
    expect(dots()).toHaveLength(1);
    await scope.dispose();
    expect(document.querySelector('[data-gv-turn-navigator]')).toBeNull();
    expect(document.querySelector('[data-gv-turn-id]')).toBeNull();
    scope = new PluginScope();
    await mount();
    expect(dots()).toHaveLength(1);
    expect(document.querySelectorAll('[data-gv-turn-navigator]')).toHaveLength(1);
    expect(loadStars).toHaveBeenLastCalledWith('chatgpt:conv:created');
  });
});
