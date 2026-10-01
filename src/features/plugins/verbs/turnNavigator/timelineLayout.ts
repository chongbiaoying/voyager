import type { Dispose, PluginScope } from '../../runtime/pluginScope';
import type { Marker } from './markerTypes';

/** Observe growing content, not just the fixed-height main/scroll viewport. */
export class TimelineLayoutObserver {
  readonly stop: Dispose;
  private readonly observer: ResizeObserver;
  private readonly targets = new Set<Element>();
  private stopped = false;
  constructor(
    scope: PluginScope,
    private readonly root: HTMLElement,
    onLayout: () => void,
  ) {
    this.observer = new ResizeObserver(() => {
      if (!this.stopped && !scope.isDisposed) onLayout();
    });
    this.stop = scope.effect(
      () => () => {
        this.stopped = true;
        this.observer.disconnect();
        this.targets.clear();
      },
      'timeline-layout',
    );
  }
  update(markers: readonly Pick<Marker, 'element' | 'shell'>[]): void {
    if (this.stopped) return;
    const next = new Set<Element>([
      this.root,
      ...this.root.children,
      ...this.root.querySelectorAll(
        '[data-thread-find-target="conversation"], .thread-scroll-container > *',
      ),
    ]);
    for (const marker of markers) {
      if (marker.element.isConnected) next.add(marker.element);
      if (marker.shell?.isConnected) next.add(marker.shell);
    }
    for (const target of this.targets)
      if (!next.has(target)) {
        this.observer.unobserve(target);
        this.targets.delete(target);
      }
    for (const target of next)
      if (!this.targets.has(target)) {
        this.observer.observe(target);
        this.targets.add(target);
      }
  }
}
