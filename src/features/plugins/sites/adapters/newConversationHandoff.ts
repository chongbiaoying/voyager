import type { PluginScope } from '../../runtime/pluginScope';
import type { ChatGptTimelineProvider, ChatGptTimelineTurn } from './chatgptTurns';

const CREATION_WINDOW_MS = 10_000;
const FORMAL_PATH = /^(.*)\/c\/[^/]+\/?$/;
const COMPOSER = '#prompt-textarea, div.ProseMirror[contenteditable="true"]';
const SEND_BUTTON = '[data-testid="send-button"], #composer-submit-button';
const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
const namespace = (url: URL): string => `${url.origin}${url.pathname.replace(/\/$/, '')}`;

/** A trusted submission on an empty page is evidence that a retained first prompt is newly created. */
export class NewConversationHandoff {
  private submission: { namespace: string; draft: string; deadline: number } | null = null;

  begin(href: string, draft: string): void {
    const url = new URL(href);
    this.cancel();
    if (
      FORMAL_PATH.test(url.pathname) ||
      url.searchParams.get('temporary-chat') === 'true' ||
      !normalize(draft)
    )
      return;
    this.submission = {
      namespace: namespace(url),
      draft: normalize(draft),
      deadline: Date.now() + CREATION_WINDOW_MS,
    };
  }

  cancel(): void {
    this.submission = null;
  }

  accept(href: string, turns: readonly ChatGptTimelineTurn[]): boolean {
    const submission = this.submission;
    if (!submission) return false;
    if (Date.now() > submission.deadline) {
      this.cancel();
      return false;
    }
    const url = new URL(href);
    const formal = url.pathname.match(FORMAL_PATH);
    if (!formal) return false;
    if (`${url.origin}${formal[1]}` !== submission.namespace) {
      this.cancel();
      return false;
    }
    const users = turns.filter((turn) => turn.role === 'user');
    if (
      users.length !== 1 ||
      !users[0].persistent ||
      !users[0].userElement ||
      normalize(users[0].userElement.textContent ?? '') !== submission.draft ||
      turns.some((turn) => !turn.persistent || turn.role === 'unknown')
    )
      return false;
    this.cancel();
    return true;
  }
}

/** Read and observe only; Voyager never submits or clears the user's composer. */
export function observeNewConversationSubmission(
  scope: PluginScope,
  provider: ChatGptTimelineProvider,
  doc: Document = document,
): void {
  const record = (composer: Element | null): void => {
    if (!composer) return;
    const text =
      composer instanceof HTMLTextAreaElement ? composer.value : (composer.textContent ?? '');
    provider.recordNewConversationSubmission(text);
  };
  scope.on(
    doc,
    'keydown',
    (event) => {
      if (
        !event.isTrusted ||
        event.key !== 'Enter' ||
        event.shiftKey ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.isComposing
      )
        return;
      record(event.target instanceof Element ? event.target.closest(COMPOSER) : null);
    },
    { capture: true },
  );
  scope.on(
    doc,
    'click',
    (event) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      if (event.target.closest(SEND_BUTTON)) {
        record(doc.querySelector(COMPOSER));
        return;
      }
      if (
        !event.target.closest(
          `${COMPOSER}, [data-gv-turn-navigator], .timeline-preview-panel, .timeline-preview-toggle`,
        )
      )
        provider.cancelNewConversationSubmission();
    },
    { capture: true },
  );
  scope.on(
    doc,
    'submit',
    (event) => {
      if (event.isTrusted && event.target instanceof Element)
        record(event.target.querySelector(COMPOSER));
    },
    { capture: true },
  );
  scope.on(doc.defaultView ?? window, 'popstate', () => provider.cancelNewConversationSubmission());
  scope.effect(() => () => provider.cancelNewConversationSubmission(), 'chatgpt-creation-intent');
}
