/**
 * Debug-channel traces for the turn navigator rail.
 *
 * The rail's interesting moments — activation, turn discovery, scroll-target
 * resolution, navigation — are invisible in a production console: `LoggerService`
 * bottoms out at WARN, so a debug channel has to be compiled in (see
 * `pluginDebug`). Each helper formats one line and keeps the navigator's call
 * sites to a single line.
 */
import { pluginDebug } from '../../runtime/pluginDebug';

const SCOPE = 'timeline';
/** Enough of a turn's text to recognise it without pasting a whole message. */
const SUMMARY_MAX = 40;

/** The `TurnNavigatorConfig` fields the traces label their lines with. */
export interface TraceConfig {
  readonly siteId: string;
  readonly siteLabel: string;
  readonly turnSelector: string;
  readonly position: string;
}

/** The marker fields the navigation traces report. */
export interface TraceMarker {
  readonly id: string;
  readonly summary: string;
  readonly element: { readonly isConnected: boolean };
}

function emit(message: string, details: Record<string, unknown>): void {
  pluginDebug(SCOPE, message, details);
}

/** The rail is up: which site, which turn selector, which conversation. */
export function started(config: TraceConfig, conversationId: string): void {
  emit('rail started', {
    siteId: config.siteId,
    label: config.siteLabel,
    turnSelector: config.turnSelector,
    conversationId,
    position: config.position,
  });
}

/** Turn discovery: what the DOM offered and what the rail carries after merging. */
export function turns(
  config: TraceConfig,
  conversationId: string,
  conversationChanged: boolean,
  mountedTurns: number,
  markers: readonly { readonly summary: string }[],
): void {
  emit('turns refreshed', {
    siteId: config.siteId,
    conversationId,
    conversationChanged,
    mountedTurns,
    markers: markers.length,
    firstSummary: markers[0]?.summary.slice(0, SUMMARY_MAX),
  });
}

/** Which element actually scrolls the conversation, and how it counts offsets. */
export function scrollTarget(
  config: TraceConfig,
  target: HTMLElement | Window | null,
  reversed: boolean,
): void {
  const container = target && target !== window ? (target as HTMLElement) : null;
  emit('scroll target set', {
    siteId: config.siteId,
    container: container ? container.className?.toString() || container.tagName : 'window',
    reversed,
    scrollTop: container?.scrollTop ?? null,
    range: container ? container.scrollHeight - container.clientHeight : null,
  });
}

/** A jump was requested for a turn the marker list does not know. */
export function ignored(turnId: string): void {
  emit('navigation ignored: unknown turn', { turnId });
}

/** A click asked for a jump: which marker, its index, and whether it is mounted. */
export function requested(marker: TraceMarker, index: number): void {
  emit('navigation requested', {
    turnId: marker.id,
    index,
    mounted: marker.element.isConnected,
    summary: marker.summary.slice(0, SUMMARY_MAX),
  });
}

/** A jump ended; `strategy` says whether it landed directly or by homing. */
export function landed(
  turnId: string,
  strategy: 'anchor' | 'homing',
  scrollTop: number,
  distance?: number,
): void {
  emit('navigation landed', {
    turnId,
    strategy,
    scrollTop: Math.round(scrollTop),
    distance: distance === undefined ? null : Math.round(distance),
  });
}

/** A far jump to a mounted turn, which the homing loop still re-aims after. */
export function longJump(turnId: string, distance: number, behavior: ScrollBehavior): void {
  emit('navigation long jump', { turnId, distance: Math.round(distance), behavior });
}

/** The target is virtualized out; the rail starts homing toward it. */
export function homing(turnId: string): void {
  emit('navigation homing: target not mounted', { turnId });
}

export function homingTimedOut(turnId: string): void {
  emit('navigation homing timed out', { turnId });
}
