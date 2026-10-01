/** Position only: ownership, hover timers and teardown stay with the navigator. */
export function showTurnTooltip(
  tooltip: HTMLElement,
  dot: HTMLElement,
  summary: string,
  starred: boolean,
): void {
  (tooltip.firstElementChild ?? tooltip).textContent = `${starred ? '★ ' : ''}${summary}`;
  tooltip.setAttribute('dir', 'auto');
  tooltip.setAttribute('aria-hidden', 'false');
  tooltip.style.width = 'min(288px, calc(100vw - 32px))';
  const rect = dot.getBoundingClientRect();
  const gap = 18;
  const tooltipWidth = tooltip.offsetWidth || 288;
  const tooltipHeight = tooltip.offsetHeight || 78;
  const leftPlacement = rect.left > window.innerWidth / 2;
  const left = leftPlacement ? rect.left - gap - tooltipWidth : rect.right + gap;
  const top = Math.max(
    8,
    Math.min(
      window.innerHeight - tooltipHeight - 8,
      rect.top + rect.height / 2 - tooltipHeight / 2,
    ),
  );
  tooltip.style.left = `${Math.max(8, Math.round(left))}px`;
  tooltip.style.top = `${Math.round(top)}px`;
  tooltip.setAttribute('data-placement', leftPlacement ? 'left' : 'right');
  tooltip.classList.add('visible');
}
