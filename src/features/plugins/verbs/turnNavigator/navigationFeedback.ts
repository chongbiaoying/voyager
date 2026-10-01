import { getTranslationSync } from '@/utils/i18n';

import type { Dispose, PluginScope } from '../../runtime/pluginScope';

export class NavigationFeedback {
  private element: HTMLElement | null = null;
  private stopTimer: Dispose | null = null;
  constructor(private readonly scope: PluginScope) {}

  clear(): void {
    void this.stopTimer?.();
    this.stopTimer = null;
    this.element?.replaceChildren();
    if (this.element) this.element.hidden = true;
  }

  show(state: 'pending' | 'success' | 'cancelled' | 'unavailable', retry: () => void): void {
    this.clear();
    if (state === 'success' || state === 'cancelled' || this.scope.isDisposed) return;
    const show = (): void => {
      if (!this.element) {
        this.element = document.createElement('div');
        this.element.className = 'gv-timeline-navigation-status';
        this.element.setAttribute('role', 'status');
        this.element.setAttribute('aria-live', 'polite');
        this.scope.mount(this.element, document.body);
      }
      this.element.hidden = false;
      const text = document.createElement('span');
      text.textContent = getTranslationSync(
        state === 'pending' ? 'timelineNavigationPending' : 'timelineNavigationUnavailable',
      );
      this.element.appendChild(text);
      if (state === 'unavailable') {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = getTranslationSync('timelineNavigationRetry');
        button.addEventListener('click', retry, { once: true });
        this.element.appendChild(button);
        this.stopTimer = this.scope.timer(() => this.clear(), 8000);
      }
    };
    if (state === 'pending') this.stopTimer = this.scope.timer(show, 200);
    else show();
  }
}
