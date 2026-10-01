import { beforeEach, describe, expect, it } from 'vitest';

import { ChatGptTimelineProvider, chatgptCollectTurnContainers } from './chatgptTurns';

function user(id: string, text = id): string {
  return `<div data-turn-id-container="${id}"><div data-user-message-bubble>${text}</div></div>`;
}

const USER_UUID = '11111111-1111-4111-8111-111111111111';
const ASSISTANT_UUID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  history.replaceState({}, '', '/c/first');
  document.body.innerHTML = '<main></main>';
});

describe('ChatGPT shared DOM collector', () => {
  it('preserves shell order and excludes bookkeeping roots', () => {
    document.querySelector('main')!.innerHTML = `
      <div data-turn-id-container="paginated-root:first"></div>
      <div data-turn-id-container="user-1"><section data-turn="user"></section></div>
      <div data-turn-id-container="assistant-1"><div data-message-author-role="assistant">Answer</div></div>
      <div data-turn-id-container="unmounted"></div>`;
    expect(
      chatgptCollectTurnContainers().map(({ id, sequence, role }) => ({ id, sequence, role })),
    ).toEqual([
      { id: 'user-1', sequence: 0, role: 'user' },
      { id: 'assistant-1', sequence: 1, role: 'assistant' },
      { id: 'unmounted', sequence: 2, role: 'unknown' },
    ]);
  });

  it('prefers mounted user content without moving its first shell position', () => {
    document.querySelector('main')!.innerHTML = `
      <div data-turn-id-container="user-1"><section data-turn="user"></section></div>
      <div data-turn-id-container="assistant-1"><section data-turn="assistant"></section></div>
      ${user('user-1', 'Mounted duplicate')}`;
    const provider = new ChatGptTimelineProvider();
    const turns = provider.snapshot('first').turns;
    expect(turns.map((turn) => turn.id)).toEqual(['user-1', 'assistant-1']);
    expect(turns[0].userElement?.textContent).toBe('Mounted duplicate');
  });
});

describe('ChatGPT timeline DOM provider', () => {
  it('reads current UUID turn-key shells without changing the legacy export collector', () => {
    document.querySelector('main')!.innerHTML = `
      <div data-turn-key="${USER_UUID}"><div data-chatgpt-search-message-ids="${USER_UUID}" data-user-message-bubble>Question</div></div>
      <div data-turn-key="${ASSISTANT_UUID}"><div data-chatgpt-selection-message-id="${ASSISTANT_UUID}">Answer</div></div>`;
    const snapshot = new ChatGptTimelineProvider().snapshot('first');
    expect(snapshot.turns.map(({ id, role, persistent }) => ({ id, role, persistent }))).toEqual([
      { id: USER_UUID, role: 'user', persistent: true },
      { id: ASSISTANT_UUID, role: 'assistant', persistent: true },
    ]);
    expect(chatgptCollectTurnContainers()).toEqual([]);
  });

  it('treats a modern Q&A round as one user turn and leaves its role unknown when only the response remains', () => {
    document.querySelector('main')!.innerHTML = `
      <div data-turn-key="${USER_UUID}">
        <div data-user-message-bubble>Question</div>
        <div data-chatgpt-selection-message-id="${ASSISTANT_UUID}">Answer</div>
      </div>`;
    const provider = new ChatGptTimelineProvider();
    expect(provider.snapshot('first').turns).toMatchObject([{ id: USER_UUID, role: 'user' }]);
    document.querySelector('[data-user-message-bubble]')!.remove();
    expect(provider.snapshot('first').turns).toMatchObject([{ id: USER_UUID, role: 'unknown' }]);
  });

  it('deduplicates modern mounted copies while preserving the first shell position', () => {
    document.querySelector('main')!.innerHTML = `
      <div data-turn-key="${USER_UUID}"></div>
      <div data-turn-key="${ASSISTANT_UUID}"><div data-chatgpt-selection-message-id="a">Answer</div></div>
      <div data-turn-key="${USER_UUID}"><div data-user-message-bubble>Mounted question</div></div>
      <div data-turn-key="${USER_UUID}"><div data-user-message-bubble>Mounted question</div></div>`;
    const turns = new ChatGptTimelineProvider().snapshot('first').turns;
    expect(turns.map((turn) => turn.id)).toEqual([USER_UUID, ASSISTANT_UUID]);
    expect(turns[0].userElement?.textContent).toBe('Mounted question');
  });

  it('does not duplicate nested legacy and modern identities for one user message', () => {
    document.querySelector('main')!.innerHTML =
      `<div data-turn-id-container="legacy-user"><div data-turn-key="${USER_UUID}"><div data-user-message-bubble>Question</div></div></div>`;
    expect(new ChatGptTimelineProvider().snapshot('first').turns.map((turn) => turn.id)).toEqual([
      'legacy-user',
    ]);
  });

  it('never persists a fallback-turn index as a native identity', () => {
    document.querySelector('main')!.innerHTML =
      '<div data-turn-key="fallback-turn-0"><div data-user-message-bubble>Question</div></div>';
    const [turn] = new ChatGptTimelineProvider().snapshot('first').turns;
    expect(turn.persistent).toBe(false);
    expect(turn.id).not.toBe('fallback-turn-0');
  });

  it('returns mounted users and retained unknown shells under a matching native root', () => {
    document.querySelector('main')!.innerHTML = `
      <div data-turn-id-container="paginated-root:first">
        ${user('user-1')}
        <div data-turn-id-container="unmounted"></div>
      </div>`;
    const snapshot = new ChatGptTimelineProvider().snapshot('first');
    expect(snapshot.status).toBe('ready');
    expect(snapshot.root?.getAttribute('data-turn-id-container')).toBe('paginated-root:first');
    expect(snapshot.turns.map(({ id, role, persistent }) => ({ id, role, persistent }))).toEqual([
      { id: 'user-1', role: 'user', persistent: true },
      { id: 'unmounted', role: 'unknown', persistent: true },
    ]);
  });

  it('checks an account and GPT scoped route against the native root id', () => {
    history.replaceState({}, '', '/u/1/g/custom/c/first');
    document.querySelector('main')!.innerHTML =
      `<div data-turn-id-container="paginated-root:first">${user('user-1')}</div>`;
    const provider = new ChatGptTimelineProvider();
    expect(provider.snapshot('first').status).toBe('ready');
    history.replaceState({}, '', '/u/1/g/custom/c/second');
    expect(provider.snapshot('second')).toMatchObject({ status: 'pending', turns: [] });
  });

  it('waits while two native conversation roots overlap', () => {
    const main = document.querySelector('main')!;
    main.innerHTML = `
      <div data-turn-id-container="paginated-root:first">${user('old')}</div>
      <div data-turn-id-container="paginated-root:second">${user('new')}</div>`;
    history.replaceState({}, '', '/c/second');
    const provider = new ChatGptTimelineProvider();
    expect(provider.snapshot('second')).toMatchObject({ status: 'pending', turns: [] });
    main.firstElementChild!.remove();
    expect(provider.snapshot('second').turns.map((turn) => turn.id)).toEqual(['new']);
  });

  it('rejects old or mixed identities after a route change without a proven native root', () => {
    const main = document.querySelector('main')!;
    main.innerHTML = user('old');
    const provider = new ChatGptTimelineProvider();
    expect(provider.snapshot('first').status).toBe('ready');
    history.replaceState({}, '', '/c/second');
    expect(provider.snapshot('second').status).toBe('pending');
    main.insertAdjacentHTML('beforeend', user('new'));
    expect(provider.snapshot('second').status).toBe('pending');
    main.firstElementChild!.remove();
    expect(provider.snapshot('second').turns.map((turn) => turn.id)).toEqual(['new']);
  });

  it('accepts A again after an uncompleted A to B to A transition when its root proves ownership', () => {
    document.querySelector('main')!.innerHTML =
      `<div data-turn-id-container="paginated-root:first">${user('old')}</div>`;
    const provider = new ChatGptTimelineProvider();
    expect(provider.snapshot('first:1').status).toBe('ready');
    history.replaceState({}, '', '/c/second');
    expect(provider.snapshot('second:2').status).toBe('pending');
    history.replaceState({}, '', '/c/first');
    expect(provider.snapshot('first:3').turns.map((turn) => turn.id)).toEqual(['old']);
  });

  it('restores the accepted modern identities on A after a pending B and rejects a mixed intermediate view', () => {
    const main = document.querySelector('main')!;
    main.innerHTML = `<div data-turn-key="${USER_UUID}"><div data-user-message-bubble>Question</div></div>`;
    const provider = new ChatGptTimelineProvider();
    expect(provider.snapshot('first:1').status).toBe('ready');
    history.replaceState({}, '', '/c/second');
    expect(provider.snapshot('second:2').status).toBe('pending');
    main.insertAdjacentHTML(
      'beforeend',
      `<div data-turn-key="${ASSISTANT_UUID}"><div data-user-message-bubble>Other conversation</div></div>`,
    );
    history.replaceState({}, '', '/c/first');
    expect(provider.snapshot('first:3').status).toBe('pending');
    main.lastElementChild!.remove();
    expect(provider.snapshot('first:3').turns.map((turn) => turn.id)).toEqual([USER_UUID]);
  });

  it('does not adopt an empty transitional DOM as proof that old conversation identities are gone', () => {
    const main = document.querySelector('main')!;
    main.innerHTML = user('old');
    const provider = new ChatGptTimelineProvider();
    provider.snapshot('first');
    history.replaceState({}, '', '/c/second');
    main.replaceChildren();
    expect(provider.snapshot('second').status).toBe('pending');
    main.innerHTML = user('old');
    expect(provider.snapshot('second').status).toBe('pending');
    main.innerHTML = user('new');
    expect(provider.snapshot('second').turns.map((turn) => turn.id)).toEqual(['new']);
  });

  it('accepts the same temporary-chat nodes after explicit promotion to a formal conversation', () => {
    history.replaceState({}, '', '/?temporary-chat=true');
    document.querySelector('main')!.innerHTML =
      `<div data-turn-id-container="client-created-root">${user('same')}</div>`;
    const provider = new ChatGptTimelineProvider();
    expect(provider.snapshot('temporary').status).toBe('ready');
    history.replaceState({}, '', '/c/created');
    provider.promoteSession('created');
    expect(provider.snapshot('created').turns.map((turn) => turn.id)).toEqual(['same']);
  });

  it('keeps page-local fallback identities stable across edits and never marks them persistent', () => {
    document.querySelector('main')!.innerHTML =
      '<div data-turn-key="local"><div data-message-author-role="user"><div data-user-message-bubble>First text</div></div></div>';
    const provider = new ChatGptTimelineProvider();
    const first = provider.snapshot('first').turns;
    expect(first).toHaveLength(1);
    expect(first[0].persistent).toBe(false);
    document.querySelector('[data-user-message-bubble]')!.textContent = 'Edited text';
    expect(provider.snapshot('first').turns[0].id).toBe(first[0].id);
    history.replaceState({}, '', '/c/second');
    expect(provider.snapshot('second').status).toBe('pending');
  });

  it('omits an explicitly hidden old root and returns only the visible conversation', () => {
    document.querySelector('main')!.innerHTML = `
      <div data-turn-id-container="paginated-root:old" hidden>${user('old')}</div>
      <div data-turn-id-container="paginated-root:first">${user('current')}</div>`;
    expect(new ChatGptTimelineProvider().snapshot('first').turns.map((turn) => turn.id)).toEqual([
      'current',
    ]);
  });

  it('uses the visible legacy copy even when the first same-id shell is hidden', () => {
    document.querySelector('main')!.innerHTML =
      `<div hidden>${user('same', 'Hidden copy')}</div>${user('same', 'Current copy')}`;
    const [turn] = new ChatGptTimelineProvider().snapshot('first').turns;
    expect(turn).toMatchObject({ id: 'same', persistent: true });
    expect(turn.userElement?.textContent).toBe('Current copy');
  });
});
