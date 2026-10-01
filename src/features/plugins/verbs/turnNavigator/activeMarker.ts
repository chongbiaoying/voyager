import type { Marker } from './markerTypes';

/** Cached centers narrow the search; current DOM bounds keep long prompts active at their start. */
export function readingMarkerId(
  markers: readonly Marker[],
  centers: readonly number[],
  reference: number,
  viewportReference?: number,
): string | null {
  if (!markers.length) return null;
  let low = 0;
  let high = centers.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (centers[middle] <= reference) low = middle + 1;
    else high = middle;
  }
  const previous = Math.max(0, low - 1);
  const next = Math.min(centers.length - 1, low);
  if (viewportReference !== undefined) {
    for (const index of [previous, next]) {
      const element = markers[index]?.element;
      if (!element?.isConnected) continue;
      const rect = element.getBoundingClientRect();
      if (rect.height > 0 && rect.top <= viewportReference && rect.bottom >= viewportReference)
        return markers[index].id;
    }
  }
  const index =
    Math.abs(centers[next] - reference) < Math.abs(centers[previous] - reference) ? next : previous;
  return markers[index]?.id ?? null;
}
