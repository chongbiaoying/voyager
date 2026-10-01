/**
 * How a navigator jump moves, and how to tell when it has stopped.
 *
 * Two facts drive this. A jump should glide — the Gemini timeline always has —
 * unless the reader asked for less motion. And the navigator's homing loop,
 * which re-aims after content mounts or re-measures, fires on a short timer; if
 * it lands while a long smooth scroll is still travelling it reads a position
 * mid-flight and jumps again, which looks worse than never animating at all.
 * So the caller waits for the scroll to settle before homing.
 */

/** Polling a smooth scroll to a stop: two identical reads, or give up. */
const SETTLE_POLL_MS = 80;
const SETTLE_TIMEOUT_MS = 1200;
/** Two stable reads, so a single coincidence mid-animation does not count. */
const STABLE_READS = 2;

export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** `smooth`, unless the reader asked for less motion. */
export function navigationScrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'instant' : 'smooth';
}

/**
 * Call `next` once the scroll offset stops changing, or after a cap.
 *
 * Polled rather than driven by `scrollend`, which is absent on the Safari this
 * extension still supports, and capped so a container that never settles — one
 * whose content keeps growing, say — cannot strand the caller. `timer` is the
 * caller's scope timer, so the poll dies with the plugin.
 */
export function afterScrollSettles(
  readScrollTop: () => number,
  timer: (run: () => void, ms: number) => void,
  isDisposed: () => boolean,
  next: () => void,
): void {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let last = readScrollTop();
  let stable = 0;

  const tick = (): void => {
    if (isDisposed()) return;
    const current = readScrollTop();
    stable = current === last ? stable + 1 : 0;
    last = current;
    if (stable >= STABLE_READS || Date.now() > deadline) {
      next();
      return;
    }
    timer(tick, SETTLE_POLL_MS);
  };

  timer(tick, SETTLE_POLL_MS);
}

/** Where an active turn sits in the viewport: a little above the middle. */
const ACTIVE_ANCHOR = 0.45;

type ScrollTarget = HTMLElement | Window | null;

/** The scroller's scrollable range: `scrollHeight - clientHeight`. */
function scrollRange(container: HTMLElement): number {
  return Math.max(0, container.scrollHeight - container.clientHeight);
}

/**
 * A `flex-direction: column-reverse` scroller (ChatGPT's thread) runs its offset
 * from 0 at the END of the content down to `-range` at its start, so the newest
 * message sits at the resting position. Everything in the navigator measures in
 * an ordinary offset that grows toward the end of the conversation, so such a
 * container is translated into that space on the way in and back out on the way
 * out; without it every jump lands on `Math.max(0, …)` — the newest message.
 *
 * The direction is a style, and a style is what decides where a scroller rests,
 * so it is read rather than probed by moving the page.
 */
export function isReverseScroller(target: ScrollTarget): boolean {
  if (!target || target === window) return false;
  const container = target as HTMLElement;
  try {
    // Negative offsets only exist on a reverse scroller, whatever its styles say.
    if (container.scrollTop < 0) return true;
    if (getComputedStyle(container).flexDirection === 'column-reverse') return true;
    const content = container.firstElementChild;
    return (
      content instanceof HTMLElement && getComputedStyle(content).flexDirection === 'column-reverse'
    );
  } catch {
    return false;
  }
}

/** A raw `scrollTop` in the navigator's growing-toward-the-end coordinate. */
export function toReadingOffset(
  container: HTMLElement,
  scrollTop: number,
  reverse: boolean,
): number {
  return reverse ? scrollTop + scrollRange(container) : scrollTop;
}

/** Back to a raw offset, clamped to the axis the container actually has. */
function toDeviceOffset(container: HTMLElement, top: number, reverse: boolean): number {
  if (!reverse) return Math.max(0, top);
  const range = scrollRange(container);
  return Math.min(0, Math.max(-range, top - range));
}

function applyScroll(target: ScrollTarget, top: number, behavior: ScrollBehavior): void {
  if (!target || target === window) {
    window.scrollTo({ top: Math.max(0, top), behavior });
    return;
  }
  const container = target as HTMLElement;
  const clamped = toDeviceOffset(container, top, isReverseScroller(container));
  if (container.scrollTo) container.scrollTo({ top: clamped, behavior });
  else container.scrollTop = clamped;
}

/** Move on the normalized reading axis, including ChatGPT's negative device offsets. */
export function scrollToReadingOffset(
  target: ScrollTarget,
  top: number,
  behavior: ScrollBehavior,
): void {
  applyScroll(target, top, behavior);
}

/** Put `center`, an offset in the target's own coordinates, on the anchor line. */
export function scrollToCenter(
  target: ScrollTarget,
  center: number,
  viewportHeight: number,
  behavior: ScrollBehavior = 'instant',
): void {
  applyScroll(target, center - viewportHeight * ACTIVE_ANCHOR, behavior);
}

/**
 * The ordinary jump: the turn is mounted and near, so it glides. The instant
 * landings elsewhere are the ones a homing loop has to re-aim, where an
 * animation fights the correction.
 *
 * `scrollTop` is the caller's reading offset, so the container branch builds a
 * reading offset too and lets `applyScroll` translate it back.
 */
export function scrollElementToAnchor(
  target: HTMLElement | Window,
  element: HTMLElement,
  scrollTop: number,
  viewportHeight: number,
): void {
  const behavior = navigationScrollBehavior();
  const rect = element.getBoundingClientRect();
  if (target === window) {
    applyScroll(
      target,
      scrollTop + rect.top + rect.height / 2 - viewportHeight * ACTIVE_ANCHOR,
      behavior,
    );
    return;
  }
  const container = target as HTMLElement;
  const containerRect = container.getBoundingClientRect();
  const top =
    scrollTop +
    rect.top -
    containerRect.top -
    container.clientHeight * ACTIVE_ANCHOR +
    rect.height / 2;
  applyScroll(container, top, behavior);
}
