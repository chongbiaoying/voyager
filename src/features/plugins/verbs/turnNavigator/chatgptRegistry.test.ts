import { beforeEach, describe, expect, it } from 'vitest';

import { hashString } from '@/core/utils/hash';
import type { StarredMessage } from '@/pages/content/timeline/starredTypes';

import { ChatGptTimelineProvider } from '../../sites/adapters/chatgptTurns';
import { ChatGptTimelineRegistry } from './chatgptRegistry';

function user(id: string, text = id): string {
  return `<div data-turn-id-container="${id}"><div data-user-message-bubble>${text}</div></div>`;
}

function star(turnId: string, content: string): StarredMessage {
  return {
    turnId,
    content,
    conversationId: 'chatgpt:conv:first',
    conversationUrl: 'https://chatgpt.com/c/first',
    starredAt: 1,
  };
}

beforeEach(() => {
  history.replaceState({}, '', '/c/first');
  document.body.innerHTML = '<main></main>';
});

describe('ChatGPT discovered-turn registry', () => {
  it('indexes repeated user text by native identity and ignores an undiscovered unknown shell', () => {
    document.querySelector('main')!.innerHTML =
      `${user('one', 'Same text')}${user('two', 'Same text')}<div data-turn-id-container="unknown"></div>`;
    const markers = new ChatGptTimelineRegistry().reconcile(
      new ChatGptTimelineProvider().snapshot('first'),
    );
    expect(markers.map((marker) => marker.id)).toEqual(['cg-one', 'cg-two']);
    expect(markers.map((marker) => marker.summary)).toEqual(['Same text', 'Same text']);
  });

  it('retains discovered text when the shell remains but its message body unmounts', () => {
    document.querySelector('main')!.innerHTML = user('one', 'Remember me');
    const provider = new ChatGptTimelineProvider();
    const registry = new ChatGptTimelineRegistry();
    registry.reconcile(provider.snapshot('first'));
    document.querySelector('[data-turn-id-container="one"]')!.replaceChildren();
    const markers = registry.reconcile(provider.snapshot('first'));
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      id: 'cg-one',
      summary: 'Remember me',
      mountedElement: null,
    });
    expect(markers[0].element).toBe(markers[0].shell);
  });

  it('hides a missing shell and restores the same marker when that branch returns', () => {
    const main = document.querySelector('main')!;
    main.innerHTML = `${user('one')}${user('two')}`;
    const provider = new ChatGptTimelineProvider();
    const registry = new ChatGptTimelineRegistry();
    registry.reconcile(provider.snapshot('first'));
    main.firstElementChild!.remove();
    expect(registry.reconcile(provider.snapshot('first')).map((marker) => marker.id)).toEqual([
      'cg-two',
    ]);
    main.insertAdjacentHTML('afterbegin', '<div data-turn-id-container="one"></div>');
    expect(registry.reconcile(provider.snapshot('first')).map((marker) => marker.id)).toEqual([
      'cg-one',
      'cg-two',
    ]);
  });

  it('updates edited text without accumulating a phantom old marker', () => {
    document.querySelector('main')!.innerHTML = user('one', 'Before');
    const provider = new ChatGptTimelineProvider();
    const registry = new ChatGptTimelineRegistry();
    registry.reconcile(provider.snapshot('first'));
    document.querySelector('[data-user-message-bubble]')!.textContent = 'After';
    expect(
      registry.reconcile(provider.snapshot('first')).map(({ id, summary }) => ({ id, summary })),
    ).toEqual([{ id: 'cg-one', summary: 'After' }]);
  });

  it('keeps separate modern UUIDs for repeated prompts and updates an edit in place', () => {
    const one = '11111111-1111-4111-8111-111111111111';
    const two = '22222222-2222-4222-8222-222222222222';
    document.querySelector('main')!.innerHTML = `
      <div data-turn-key="${one}"><div data-user-message-bubble>Same text</div></div>
      <div data-turn-key="${two}"><div data-user-message-bubble>Same text</div></div>`;
    const provider = new ChatGptTimelineProvider();
    const registry = new ChatGptTimelineRegistry();
    expect(registry.reconcile(provider.snapshot('first')).map((marker) => marker.id)).toEqual([
      `cg-${one}`,
      `cg-${two}`,
    ]);
    document.querySelector('[data-user-message-bubble]')!.textContent = 'Edited first question';
    expect(
      registry
        .reconcile(provider.snapshot('first'))
        .map(({ id, summary, persistent }) => ({ id, summary, persistent })),
    ).toEqual([
      { id: `cg-${one}`, summary: 'Edited first question', persistent: true },
      { id: `cg-${two}`, summary: 'Same text', persistent: true },
    ]);
  });

  it('keeps a discovered modern user when only its assistant half remains mounted', () => {
    const one = '11111111-1111-4111-8111-111111111111';
    const answer = '22222222-2222-4222-8222-222222222222';
    document.querySelector('main')!.innerHTML =
      `<div data-turn-key="${one}"><div data-user-message-bubble>Question</div><div data-chatgpt-selection-message-id="${answer}">Answer</div></div>`;
    const provider = new ChatGptTimelineProvider();
    const registry = new ChatGptTimelineRegistry();
    registry.reconcile(provider.snapshot('first'));
    document.querySelector('[data-user-message-bubble]')!.remove();
    expect(registry.reconcile(provider.snapshot('first'))).toMatchObject([
      { id: `cg-${one}`, summary: 'Question', mountedElement: null },
    ]);
    document.querySelector('[data-turn-key]')!.setAttribute('data-turn', 'assistant');
    expect(registry.reconcile(provider.snapshot('first'))).toEqual([]);
  });

  it('hides a pending snapshot without discarding discovered data, while reset starts clean', () => {
    document.querySelector('main')!.innerHTML = user('one', 'Before');
    const provider = new ChatGptTimelineProvider();
    const registry = new ChatGptTimelineRegistry();
    registry.reconcile(provider.snapshot('first'));
    expect(registry.reconcile({ status: 'pending', root: null, turns: [] })).toEqual([]);
    document.querySelector('[data-turn-id-container="one"]')!.replaceChildren();
    expect(registry.reconcile(provider.snapshot('first'))).toHaveLength(1);
    registry.reset();
    expect(registry.reconcile(provider.snapshot('first'))).toEqual([]);
  });

  it('finds a previously unknown user after its body mounts in the retained order', () => {
    document.querySelector('main')!.innerHTML =
      `<div data-turn-id-container="one"></div>${user('two')}`;
    const provider = new ChatGptTimelineProvider();
    const registry = new ChatGptTimelineRegistry();
    expect(registry.reconcile(provider.snapshot('first')).map((marker) => marker.id)).toEqual([
      'cg-two',
    ]);
    document.querySelector('[data-turn-id-container="one"]')!.innerHTML =
      '<div data-user-message-bubble>Older question</div>';
    expect(registry.reconcile(provider.snapshot('first')).map((marker) => marker.id)).toEqual([
      'cg-one',
      'cg-two',
    ]);
  });
});

describe('ChatGPT native stars and conservative legacy aliases', () => {
  it('matches native stars exactly even after editing and never extracts a native id hash', () => {
    document.querySelector('main')!.innerHTML = user('native-hash-suffix', 'Edited');
    const registry = new ChatGptTimelineRegistry();
    registry.reconcile(new ChatGptTimelineProvider().snapshot('first'));
    expect(
      registry
        .resolveStars([star('cg-native-hash-suffix', 'Original')])
        .get('cg-native-hash-suffix'),
    ).toEqual({ storedTurnId: 'cg-native-hash-suffix', starredAt: 1 });
    expect(registry.findMarker('other-prefix-native-hash-suffix')).toBeUndefined();
  });

  it('resolves one legacy content match and retains its exact stored id for unstar', () => {
    document.querySelector('main')!.innerHTML = user('one', 'Unique text');
    const registry = new ChatGptTimelineRegistry();
    registry.reconcile(new ChatGptTimelineProvider().snapshot('first'));
    const storedTurnId = `c-3-${hashString('Unique text')}`;
    expect(registry.resolveStars([star(storedTurnId, ' Unique\ntext ')]).get('cg-one')).toEqual({
      storedTurnId,
      starredAt: 1,
    });
    expect(registry.findMarker(storedTurnId)?.id).toBe('cg-one');
  });

  it('accepts the background service truncated legacy preview only with the unique full-text hash', () => {
    const text = 'A lengthy question '.repeat(10).trim();
    document.querySelector('main')!.innerHTML = user('one', text);
    const registry = new ChatGptTimelineRegistry();
    registry.reconcile(new ChatGptTimelineProvider().snapshot('first'));
    const storedTurnId = `c-${hashString(text)}`;
    expect(
      registry.resolveStars([star(storedTurnId, `${text.slice(0, 60)}...`)]).get('cg-one'),
    ).toEqual({ storedTurnId, starredAt: 1 });
    expect(registry.resolveStars([star(storedTurnId, `X${text.slice(1, 60)}...`)]).size).toBe(0);
  });

  it('does not resolve repeated legacy text, including a mount-index or occurrence suffix', () => {
    document.querySelector('main')!.innerHTML =
      `${user('one', 'Same text')}${user('two', 'Same text')}`;
    const registry = new ChatGptTimelineRegistry();
    registry.reconcile(new ChatGptTimelineProvider().snapshot('first'));
    const storedTurnId = `c-2-${hashString('Same text')}~2`;
    expect(registry.resolveStars([star(storedTurnId, 'Same text')]).size).toBe(0);
    expect(registry.findMarker(storedTurnId)).toBeUndefined();
    expect(registry.findMarker('cg-two')?.id).toBe('cg-two');
  });

  it('keeps archived same-text ambiguity after switching the visible branch', () => {
    const main = document.querySelector('main')!;
    main.innerHTML = user('old', 'Same text');
    const provider = new ChatGptTimelineProvider();
    const registry = new ChatGptTimelineRegistry();
    registry.reconcile(provider.snapshot('first'));
    main.innerHTML = user('new', 'Same text');
    registry.reconcile(provider.snapshot('first'));
    expect(registry.resolveStars([star(`c-${hashString('Same text')}`, 'Same text')]).size).toBe(0);
  });

  it('withholds an uncertain legacy match while still recognizing exact native stars', () => {
    document.querySelector('main')!.innerHTML =
      `${user('one', 'Unique text')}<div data-turn-id-container="unknown"></div>`;
    const registry = new ChatGptTimelineRegistry();
    registry.reconcile(new ChatGptTimelineProvider().snapshot('first'));
    const messages = [
      star(`c-${hashString('Unique text')}`, 'Unique text'),
      star('cg-one', 'Unique text'),
    ];
    expect(registry.resolveStars(messages).get('cg-one')?.storedTurnId).toBe('cg-one');
    expect(registry.findMarker(`c-${hashString('Unique text')}`)).toBeUndefined();
  });

  it('rejects conflicting legacy records rather than choosing one stored id', () => {
    document.querySelector('main')!.innerHTML = user('one', 'Unique text');
    const registry = new ChatGptTimelineRegistry();
    registry.reconcile(new ChatGptTimelineProvider().snapshot('first'));
    const hash = hashString('Unique text');
    expect(
      registry.resolveStars([star(`c-${hash}`, 'Unique text'), star(`c-2-${hash}`, 'Unique text')])
        .size,
    ).toBe(0);
  });

  it('supports exact page-local stars without attaching native or legacy stars to a fallback identity', () => {
    document.querySelector('main')!.innerHTML = '<div data-user-message-bubble>Unique text</div>';
    const registry = new ChatGptTimelineRegistry();
    const [marker] = registry.reconcile(new ChatGptTimelineProvider().snapshot('first'));
    expect(marker.persistent).toBe(false);
    expect(marker.nativeId).toBeNull();
    expect(registry.resolveStars([star(marker.id, 'Unique text')]).get(marker.id)).toEqual({
      storedTurnId: marker.id,
      starredAt: 1,
    });
    expect(
      registry.resolveStars([
        star(`c-${hashString('Unique text')}`, 'Unique text'),
        star('cg-page-1', 'Unique text'),
        star('ct-page-unknown', 'Unique text'),
      ]).size,
    ).toBe(0);
  });
});
