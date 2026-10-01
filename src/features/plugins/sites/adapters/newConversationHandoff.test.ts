import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginScope } from '../../runtime/pluginScope';
import { ChatGptTimelineProvider } from './chatgptTurns';
import { observeNewConversationSubmission } from './newConversationHandoff';

const ID = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const prompt = (text = 'First prompt', id = ID) =>
  `<div data-turn-key="${id}"><div data-user-message-bubble>${text}</div></div>`;
let provider: ChatGptTimelineProvider;
const main = () => document.querySelector('main')!;
function prepare() {
  provider.snapshot('temporary');
  provider.recordNewConversationSubmission('First prompt');
  main().innerHTML = prompt();
  expect(provider.snapshot('temporary').status).toBe('ready');
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  history.replaceState({}, '', '/');
  document.body.innerHTML = '<main></main>';
  provider = new ChatGptTimelineProvider();
});
afterEach(() => vi.useRealTimers());
describe('new conversation handoff evidence', () => {
  it('accepts a retained first UUID prompt when formal URL follows its submission', () => {
    prepare();
    history.replaceState({}, '', '/c/created');
    expect(provider.snapshot('formal').turns.map((x) => x.id)).toEqual([ID]);
    expect(provider.snapshot('formal').status).toBe('ready');
  });
  it('accepts a formal URL before the first prompt mounts', () => {
    provider.snapshot('temporary');
    provider.recordNewConversationSubmission('First prompt');
    history.replaceState({}, '', '/c/created');
    main().innerHTML = prompt();
    expect(provider.snapshot('formal').status).toBe('ready');
  });
  it('does not accept a pre-existing temporary prompt as creation evidence', () => {
    main().innerHTML = prompt();
    provider.recordNewConversationSubmission('First prompt');
    provider.snapshot('temporary');
    history.replaceState({}, '', '/c/old');
    expect(provider.snapshot('formal').status).toBe('pending');
  });
  it('keeps stale temporary DOM blocked without submission evidence', () => {
    main().innerHTML = prompt();
    provider.snapshot('temporary');
    history.replaceState({}, '', '/c/old');
    expect(provider.snapshot('formal').status).toBe('pending');
  });
  it('rejects manual navigation after submission even when stale prompt matches', () => {
    prepare();
    provider.cancelNewConversationSubmission();
    history.replaceState({}, '', '/c/old');
    expect(provider.snapshot('formal').status).toBe('pending');
  });
  it('rejects account changes and consumes cancelled evidence', () => {
    history.replaceState({}, '', '/u/0/');
    prepare();
    history.replaceState({}, '', '/u/1/c/created');
    expect(provider.snapshot('formal').status).toBe('pending');
    history.replaceState({}, '', '/u/0/c/created');
    expect(provider.snapshot('other').status).toBe('pending');
  });
  it('preserves account and custom GPT route namespaces', () => {
    history.replaceState({}, '', '/u/1/g/my-gpt');
    prepare();
    history.replaceState({}, '', '/u/1/g/my-gpt/c/created');
    expect(provider.snapshot('formal').status).toBe('ready');
  });
  it('rejects a mismatched prompt or ambiguous second user', () => {
    prepare();
    main().innerHTML = prompt('Wrong prompt');
    history.replaceState({}, '', '/c/created');
    expect(provider.snapshot('formal').status).toBe('pending');
    main().innerHTML = prompt() + prompt('Second prompt', SECOND);
    expect(provider.snapshot('formal').status).toBe('pending');
  });
  it('expires evidence instead of accepting a later old conversation', () => {
    prepare();
    vi.advanceTimersByTime(10_001);
    history.replaceState({}, '', '/c/old');
    expect(provider.snapshot('formal').status).toBe('pending');
  });
  it('never promotes temporary-chat query sessions using normal creation evidence', () => {
    history.replaceState({}, '', '/?temporary-chat=true');
    prepare();
    history.replaceState({}, '', '/c/old');
    expect(provider.snapshot('formal').status).toBe('pending');
  });
  it('rejects synthetic composer events and cancels evidence on browser history', async () => {
    const scope = new PluginScope();
    main().innerHTML = '<div id="prompt-textarea" contenteditable="true">First prompt</div>';
    observeNewConversationSubmission(scope, provider);
    const record = vi.spyOn(provider, 'recordNewConversationSubmission');
    document
      .querySelector('#prompt-textarea')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(record).not.toHaveBeenCalled();
    main().innerHTML = '';
    prepare();
    window.dispatchEvent(new PopStateEvent('popstate'));
    history.replaceState({}, '', '/c/old');
    expect(provider.snapshot('formal').status).toBe('pending');
    await scope.dispose();
  });
  it('removes scoped listeners and cancels evidence at plugin stop', async () => {
    const scope = new PluginScope();
    observeNewConversationSubmission(scope, provider);
    prepare();
    await scope.dispose();
    history.replaceState({}, '', '/c/created');
    expect(provider.snapshot('formal').status).toBe('pending');
  });
});
