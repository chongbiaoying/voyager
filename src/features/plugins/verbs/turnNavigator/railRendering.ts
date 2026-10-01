import type { TimelineStyle } from '@/core/types/common';

import type { Dot, Marker } from './markerTypes';
interface RailActions {
  activeId(): string | null;
  suppressed(): boolean;
  navigate(id: string): void;
  longPress(dot: Dot): void;
  cancelLongPress(): void;
  scheduleTooltip(dot: Dot): void;
  showTooltip(dot: Dot): void;
  hideTooltip(): void;
}
export function renderTimelineDots(
  track: HTMLElement,
  markers: Marker[],
  style: TimelineStyle,
  actions: RailActions,
): void {
  const keep = new Set(markers.map((marker) => marker.id));
  for (const child of Array.from(track.children)) {
    if (!keep.has((child as Dot).dataset.targetTurnId ?? '')) child.remove();
  }
  const last = Math.max(1, markers.length - 1);
  const compactOffsets = compactMarkerOffsets(
    markers.length,
    track.parentElement?.clientHeight ?? 0,
  );
  // Overlapping tick strokes otherwise look like another continuous rail.
  // Keep every accessible target; paint spaced ticks and use preview for precision.
  const chatgptCompact =
    style === 'compact' &&
    track.closest<HTMLElement>('[data-gv-turn-navigator]')?.dataset.gvTurnNavigator === 'chatgpt';
  const pitch = Math.abs((compactOffsets[1] ?? 0) - (compactOffsets[0] ?? 0));
  const paintStride = chatgptCompact && pitch > 0 ? Math.max(1, Math.ceil(6 / pitch)) : 1;
  markers.forEach((marker, index) => {
    const fresh = !marker.dotElement;
    const dot = marker.dotElement ?? (document.createElement('button') as Dot);
    dot.className = 'timeline-dot';
    dot.classList.toggle(
      'gv-timeline-density-hidden',
      index % paintStride !== 0 && index !== markers.length - 1,
    );
    dot.type = 'button';
    dot.dataset.targetTurnId = marker.id;
    dot.dataset.markerIndex = String(index);
    if (style === 'compact') {
      dot.style.setProperty('--timeline-compact-offset', `${compactOffsets[index] ?? 0}px`);
    } else {
      dot.style.setProperty('--n', String(markers.length === 1 ? 0.5 : index / last));
    }
    dot.setAttribute('aria-label', marker.summary || `Message ${index + 1}`);
    dot.setAttribute('aria-pressed', marker.starred ? 'true' : 'false');
    dot.setAttribute('aria-current', marker.id === actions.activeId() ? 'true' : 'false');
    dot.classList.toggle('starred', marker.starred);
    dot.classList.toggle('active', marker.id === actions.activeId());
    if (fresh) {
      dot.addEventListener('click', (event) => {
        // The compact rail is itself the preview-panel toggle: a tick click
        // must jump, not toggle the panel it bubbles up to.
        event.stopPropagation();
        if (actions.suppressed()) {
          event.preventDefault();
          return;
        }
        actions.navigate(marker.id);
      });
      dot.addEventListener('pointerdown', () => actions.longPress(dot));
      dot.addEventListener('pointerup', () => actions.cancelLongPress());
      dot.addEventListener('pointercancel', () => actions.cancelLongPress());
      dot.addEventListener('pointerenter', () => actions.scheduleTooltip(dot));
      dot.addEventListener('pointerleave', () => {
        actions.cancelLongPress();
        actions.hideTooltip();
      });
      dot.addEventListener('focus', () => actions.showTooltip(dot));
      dot.addEventListener('blur', () => actions.hideTooltip());
    }
    marker.dotElement = dot;
    const at = track.children[index];
    if (at !== dot) track.insertBefore(dot, at ?? null);
  });
}
export function compactMarkerOffsets(count: number, height: number): number[] {
  const span = height > 0 ? Math.max(0, height - 32) : 240;
  const gap = count > 1 ? Math.min(10, span / (count - 1)) : 0;
  return Array.from({ length: count }, (_, index) => (index - (count - 1) / 2) * gap);
}
