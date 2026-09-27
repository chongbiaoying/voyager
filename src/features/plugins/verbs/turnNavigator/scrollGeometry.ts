/**
 * How the navigator reads positions out of a conversation's scroller.
 *
 * Every comparison in the rail — marker centres, the active-turn binary search,
 * the homing bounds — lives on one axis: an offset that is 0 at the start of the
 * conversation and grows toward its end. A `column-reverse` scroller (ChatGPT's
 * thread) counts the other way, so its raw offsets are translated on the way in.
 *
 * These helpers take the resolved target as an explicit input and own no state;
 * the navigator keeps the target and its reversal flag.
 */
import { toReadingOffset } from './scrollMotion';

type ScrollTarget = HTMLElement | Window | null;

/** The element form of a target, or null when the page itself scrolls. */
function containerOf(target: ScrollTarget): HTMLElement | null {
  return target && target !== window ? (target as HTMLElement) : null;
}

/**
 * The scroller's offset on the reading axis: 0 at the start of the conversation,
 * growing toward its end. For a reverse scroller that is `scrollTop + range`,
 * which keeps every comparison in the navigator on one axis.
 */
export function readingScrollTop(target: ScrollTarget, reversed: boolean): number {
  const container = containerOf(target);
  if (container) return toReadingOffset(container, container.scrollTop, reversed);
  return window.scrollY || document.documentElement.scrollTop || 0;
}

/** Top edge of the scroller's own box; the origin the viewport maths measures from. */
export function viewportTop(target: ScrollTarget): number {
  const container = containerOf(target);
  return container ? container.getBoundingClientRect().top : 0;
}

/** Visible height: the container's, or the window's while the page scrolls. */
export function viewportHeight(target: ScrollTarget): number {
  const container = containerOf(target);
  if (container) return container.clientHeight;
  return window.innerHeight || document.documentElement.clientHeight || 0;
}

/** Full scrollable height: the container's, or the document's. */
export function contentHeight(target: ScrollTarget): number {
  const container = containerOf(target);
  return container
    ? container.scrollHeight
    : (document.scrollingElement || document.documentElement).scrollHeight;
}

/** Is the reading offset pinned to the end of the conversation? */
export function readingAtBottom(target: ScrollTarget, reversed: boolean): boolean {
  const visible = viewportHeight(target);
  const content = contentHeight(target);
  return content > visible && readingScrollTop(target, reversed) + visible >= content - 2;
}

/** An element's centre on the reading axis, from the caller's base readings. */
export function elementCenter(
  element: HTMLElement,
  scrollTop: number,
  containerTop: number,
): number {
  const rect = element.getBoundingClientRect();
  return scrollTop + rect.top - containerTop + rect.height / 2;
}

/** Is any part of the element between the viewport's top and bottom edges? */
export function elementInViewport(element: HTMLElement, top: number, bottom: number): boolean {
  const rect = element.getBoundingClientRect();
  return rect.bottom >= top && rect.top <= bottom;
}
