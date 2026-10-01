import type { PreviewMarkerData } from './types';

export const PREVIEW_VIRTUAL_THRESHOLD = 100;
const ROW_HEIGHT_PX = 48;
const OVERSCAN_ROWS = 6;
const FALLBACK_VIEWPORT_HEIGHT_PX = 384;
const WINDOW_CLASS = 'gv-timeline-preview-window';

/** Owns only the rendered window; the panel owns the conversation and filtering. */
export class TimelinePreviewVirtualList {
  private windowEl: HTMLElement | null = null;
  private markers: ReadonlyArray<PreviewMarkerData> = [];
  private items = new Map<string, HTMLElement>();

  constructor(
    private readonly listEl: HTMLElement,
    private readonly createItem: (marker: PreviewMarkerData) => HTMLElement,
    private readonly beforeRender: () => void,
  ) {
    listEl.addEventListener('scroll', this.onScroll, { passive: true });
    listEl.addEventListener('keydown', this.onKeyDown);
  }

  setMarkers(markers: ReadonlyArray<PreviewMarkerData>): void {
    const focusedId = this.focusedTurnId();
    this.clear();
    this.markers = markers;
    this.windowEl = document.createElement('div');
    this.windowEl.className = WINDOW_CLASS;
    this.windowEl.style.height = `${markers.length * ROW_HEIGHT_PX}px`;
    this.listEl.replaceChildren(this.windowEl);
    const maxScroll = Math.max(0, markers.length * ROW_HEIGHT_PX - this.viewportHeight());
    this.listEl.scrollTop = Math.min(this.listEl.scrollTop, maxScroll);
    this.render(focusedId);
    if (focusedId) this.items.get(focusedId)?.focus({ preventScroll: true });
  }

  scrollToTurn(turnId: string): void {
    const index = this.markers.findIndex((marker) => marker.id === turnId);
    if (index < 0 || !this.windowEl) return;
    const inset = Number.parseFloat(getComputedStyle(this.listEl).paddingTop) || 0;
    const top = index * ROW_HEIGHT_PX + inset;
    const bottom = top + ROW_HEIGHT_PX;
    if (top < this.listEl.scrollTop) this.listEl.scrollTop = top;
    else if (bottom > this.listEl.scrollTop + this.viewportHeight()) {
      this.listEl.scrollTop = bottom - this.viewportHeight();
    }
    this.render();
  }

  refresh(): void {
    this.render();
  }

  clear(): void {
    this.windowEl?.remove();
    this.windowEl = null;
    this.items.clear();
    this.markers = [];
  }

  destroy(): void {
    this.clear();
    this.listEl.removeEventListener('scroll', this.onScroll);
    this.listEl.removeEventListener('keydown', this.onKeyDown);
  }

  private viewportHeight(): number {
    return this.listEl.clientHeight || FALLBACK_VIEWPORT_HEIGHT_PX;
  }

  private focusedTurnId(): string | null {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement) || !this.listEl.contains(element)) return null;
    return element.closest<HTMLElement>('.timeline-preview-item')?.dataset.turnId ?? null;
  }

  private render(focusedId = this.focusedTurnId()): void {
    if (!this.windowEl) return;
    const start = Math.max(0, Math.floor(this.listEl.scrollTop / ROW_HEIGHT_PX) - OVERSCAN_ROWS);
    const end = Math.min(
      this.markers.length,
      Math.ceil((this.listEl.scrollTop + this.viewportHeight()) / ROW_HEIGHT_PX) + OVERSCAN_ROWS,
    );
    const indices = new Set<number>();
    for (let index = start; index < end; index++) indices.add(index);
    // A focused row survives a mouse scroll even when it leaves the viewport.
    const focusedIndex = this.markers.findIndex((marker) => marker.id === focusedId);
    if (focusedIndex >= 0) indices.add(focusedIndex);
    const desiredIds = new Set([...indices].map((index) => this.markers[index].id));
    const changed =
      desiredIds.size !== this.items.size || [...desiredIds].some((id) => !this.items.has(id));
    if (!changed) return;
    this.beforeRender();
    for (const [id, item] of this.items) {
      if (desiredIds.has(id)) continue;
      item.remove();
      this.items.delete(id);
    }
    for (const index of [...indices].sort((a, b) => a - b)) {
      const marker = this.markers[index];
      if (this.items.has(marker.id)) continue;
      const item = this.createItem(marker);
      item.style.top = `${index * ROW_HEIGHT_PX}px`;
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-label', `${marker.index + 1}. ${marker.summary}`);
      this.items.set(marker.id, item);
      const next = Array.from(this.windowEl.children).find(
        (child) => Number.parseFloat((child as HTMLElement).style.top) > index * ROW_HEIGHT_PX,
      );
      this.windowEl.insertBefore(item, next ?? null);
    }
  }

  private onScroll = (): void => this.render();

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.windowEl || !(event.target instanceof HTMLElement)) return;
    const item = event.target.closest<HTMLElement>('.timeline-preview-item');
    const index = this.markers.findIndex((marker) => marker.id === item?.dataset.turnId);
    if (index < 0 || !item) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      item.click();
      return;
    }
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowDown':
        nextIndex = Math.min(this.markers.length - 1, index + 1);
        break;
      case 'ArrowUp':
        nextIndex = Math.max(0, index - 1);
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = this.markers.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    const next = this.markers[nextIndex];
    this.scrollToTurn(next.id);
    this.items.get(next.id)?.focus({ preventScroll: true });
  };
}
