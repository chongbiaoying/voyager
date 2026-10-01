import { PluginScope } from '../../runtime/pluginScope';
import type { Dispose } from '../../runtime/pluginScope';
import * as geometry from './scrollGeometry';
import { isReverseScroller, navigationScrollBehavior, scrollToReadingOffset } from './scrollMotion';

export interface ChatGptNavigationTarget {
  element: HTMLElement;
  mounted: boolean;
  root: HTMLElement;
}

export interface ChatGptNavigationActions {
  resolve(id: string): ChatGptNavigationTarget | null;
  scrollTarget(element: HTMLElement): HTMLElement | Window;
  isCurrent(session: string): boolean;
  state(state: 'pending' | 'success' | 'cancelled' | 'unavailable', id: string): void;
}

const TIMEOUT_MS = 3000;
const POLL_MS = 80;
const REPOSITION_MS = 160;
const TOLERANCE_PX = 24;
const LONG_TURN_INSET_PX = 32;
const NAVIGATION_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']);

/** Every request owns its callbacks; a newer click cannot inherit an old settle loop. */
export class ChatGptNavigationController {
  private request: {
    id: string;
    scope: PluginScope;
    release: Dispose;
    target: HTMLElement | Window | null;
  } | null = null;

  constructor(
    private readonly scope: PluginScope,
    private readonly actions: ChatGptNavigationActions,
  ) {
    scope.effect(() => () => this.cancel(), 'chatgpt-navigation');
  }

  start(id: string, session: string): void {
    this.cancel();
    if (this.scope.isDisposed || !this.actions.isCurrent(session)) return;
    const first = this.actions.resolve(id);
    if (!first) {
      this.actions.state('unavailable', id);
      return;
    }
    const scope = new PluginScope();
    const release = this.scope.effect(() => () => scope.dispose(), 'chatgpt-navigation-request');
    const request = { id, scope, release, target: null as HTMLElement | Window | null };
    this.request = request;
    const deadline = Date.now() + TIMEOUT_MS;
    let lastOffset = Number.NaN;
    let stable = 0;
    let lastAim = 0;
    let firstAim = true;
    let currentRoot = first.root;
    this.actions.state('pending', id);

    const current = (): boolean =>
      this.request === request &&
      !scope.isDisposed &&
      !this.scope.isDisposed &&
      this.actions.isCurrent(session);
    const finish = (state: 'success' | 'unavailable' | 'cancelled'): void => {
      if (this.request !== request) return;
      this.stop(state !== 'success');
      this.actions.state(state, id);
    };
    const poll = (): void => {
      if (!current()) {
        finish('cancelled');
        return;
      }
      const target = this.actions.resolve(id);
      if (!current()) return;
      if (!target) {
        finish('unavailable');
        return;
      }
      currentRoot = target.root;
      const scroller = this.actions.scrollTarget(target.element);
      request.target = scroller;
      const reverse = isReverseScroller(scroller);
      const offset = geometry.readingScrollTop(scroller, reverse);
      const height = geometry.viewportHeight(scroller);
      const rect = target.element.getBoundingClientRect();
      const top = geometry.viewportTop(scroller);
      const long = target.mounted && rect.height > height;
      const anchor = long ? LONG_TURN_INSET_PX : height * 0.45;
      const desired = Math.max(
        0,
        Math.min(
          Math.max(0, geometry.contentHeight(scroller) - height),
          offset + rect.top - top + (long ? 0 : rect.height / 2) - anchor,
        ),
      );
      stable = offset === lastOffset ? stable + 1 : 0;
      lastOffset = offset;
      const visible = rect.bottom > top && rect.top < top + height;
      if (target.mounted && visible && Math.abs(offset - desired) <= TOLERANCE_PX && stable >= 2) {
        finish('success');
        return;
      }
      if (Date.now() >= deadline) {
        finish('unavailable');
        return;
      }
      const settled = stable >= 2;
      if (
        firstAim ||
        (!target.mounted && !visible && Date.now() - lastAim >= REPOSITION_MS) ||
        (target.mounted && settled && Math.abs(offset - desired) > TOLERANCE_PX)
      ) {
        scrollToReadingOffset(
          scroller,
          desired,
          firstAim && target.mounted ? navigationScrollBehavior() : 'instant',
        );
        firstAim = false;
        lastAim = Date.now();
        stable = 0;
      }
      scope.timer(poll, POLL_MS);
    };

    const isChatInteraction = (event: Event): boolean => {
      const element = event.target instanceof Element ? event.target : null;
      if (
        element?.closest(
          '[data-gv-turn-navigator], .timeline-preview-panel, .timeline-preview-toggle',
        )
      )
        return false;
      if (!element) return false;
      if (currentRoot.contains(element)) return true;
      // Native scrollbars target their scroll container, outside the content root.
      return request.target instanceof HTMLElement && element === request.target;
    };
    for (const name of ['wheel', 'touchmove', 'pointerdown'] as const) {
      scope.on(
        window,
        name,
        (event) => {
          if (isChatInteraction(event)) finish('cancelled');
        },
        { passive: true },
      );
    }
    scope.on(window, 'keydown', (event) => {
      if (!NAVIGATION_KEYS.has(event.key) || event.defaultPrevented) return;
      const element = event.target instanceof Element ? event.target : null;
      if (element?.closest('input, textarea, [contenteditable], .timeline-preview-panel')) return;
      finish('cancelled');
    });
    poll();
  }

  cancel(): void {
    const id = this.request?.id;
    this.stop(true);
    if (id) this.actions.state('cancelled', id);
  }

  private stop(stopAnimation: boolean): void {
    const request = this.request;
    this.request = null;
    if (!request) return;
    if (stopAnimation && request.target) {
      scrollToReadingOffset(
        request.target,
        geometry.readingScrollTop(request.target, isReverseScroller(request.target)),
        'instant',
      );
    }
    void request.release();
  }
}
