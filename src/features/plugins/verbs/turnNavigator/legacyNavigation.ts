import { type Dispose, PluginScope } from '../../runtime/pluginScope';
import type { Marker } from './markerTypes';
import * as trace from './navTrace';
import {
  afterScrollSettles,
  navigationScrollBehavior,
  scrollElementToAnchor,
  scrollToCenter,
} from './scrollMotion';

interface LegacyNavigationActions {
  findMarker(id: string): Marker | undefined;
  markers(): Marker[];
  computeCenter(element: HTMLElement): number;
  viewportHeight(): number;
  scrollTop(): number;
  scrollHeight(): number;
  scrollTarget(element: HTMLElement): HTMLElement | Window;
  currentTarget(): HTMLElement | Window | null;
  inViewport(element: HTMLElement): boolean;
  lockActive(): void;
  setActive(id: string): void;
}
const PENDING_NAVIGATION_TIMEOUT_MS = 8000;
const PENDING_NAVIGATION_HOP_MS = 200;
const LONG_JUMP_VIEWPORTS = 3;
const ACTIVE_ANCHOR = 0.45;

/** Claude/DeepSeek's existing sliding-window homing, with one owner for pending work. */
export class LegacyNavigationController {
  private revision = 0;
  private pendingNavigationId: string | null = null;
  private pendingNavigationUntil = 0;
  private stopPendingNavigationTimer: Dispose | null = null;
  private stopUserScrollListeners: Dispose[] = [];
  private pendingNavigationLo = 0;
  private pendingNavigationHi = 0;
  private pendingNavigationProbed = false;
  constructor(
    private readonly scope: PluginScope,
    private readonly actions: LegacyNavigationActions,
  ) {
    scope.effect(() => () => this.clearPendingNavigation(), 'legacy-navigation');
  }
  navigateTo(turnId: string): void {
    const marker = this.actions.findMarker(turnId);
    if (!marker) return trace.ignored(turnId);
    this.actions.lockActive();
    this.actions.setActive(marker.id);
    trace.requested(marker, this.actions.markers().indexOf(marker));
    if (marker.element.isConnected) {
      const center = this.actions.computeCenter(marker.element);
      const anchorOffset = this.actions.viewportHeight() * ACTIVE_ANCHOR;
      const distance = Math.abs(center - (this.actions.scrollTop() + anchorOffset));
      if (distance <= this.actions.viewportHeight() * LONG_JUMP_VIEWPORTS) {
        this.clearPendingNavigation();
        scrollElementToAnchor(
          this.actions.scrollTarget(marker.element),
          marker.element,
          this.actions.scrollTop(),
          this.actions.viewportHeight(),
        );
        trace.landed(marker.id, 'anchor', this.actions.scrollTop(), distance);
        return;
      }
      // Long jump to a mounted turn: Claude re-measures once the landing region
      // mounts, so the homing loop still fine-aims — after the scroll settles,
      // never into one still travelling. See scrollMotion.ts.
      this.beginPendingNavigation(marker);
      this.pendingNavigationProbed = true;
      const revision = this.revision;
      const hop = (): void => {
        if (revision === this.revision) this.schedulePendingNavigationHop();
      };
      const behavior = navigationScrollBehavior();
      trace.longJump(marker.id, distance, behavior);
      scrollToCenter(this.actions.currentTarget(), center, this.actions.viewportHeight(), behavior);
      if (behavior !== 'smooth') hop();
      else {
        const timer = (run: () => void, ms: number): void => void this.scope.timer(run, ms);
        afterScrollSettles(
          () => this.actions.scrollTop(),
          timer,
          () => this.scope.isDisposed || revision !== this.revision,
          hop,
        );
      }
      return;
    }
    // Virtualized out: the remembered offset is only an estimate (Claude
    // re-measures content as it mounts), so home in iteratively instead of
    // trusting a single jump.
    trace.homing(marker.id);
    this.beginPendingNavigation(marker);
    this.homePendingNavigation();
  }

  private beginPendingNavigation(marker: Marker): void {
    this.clearPendingNavigation();
    this.pendingNavigationId = marker.id;
    this.pendingNavigationUntil = Date.now() + PENDING_NAVIGATION_TIMEOUT_MS;
    this.pendingNavigationLo = 0;
    this.pendingNavigationHi = Math.max(
      this.actions.scrollHeight(),
      marker.center + this.actions.viewportHeight(),
    );
    this.pendingNavigationProbed = false;
    if (this.scope.isDisposed) return;
    this.stopUserScrollListeners = [
      this.scope.on(window, 'wheel', this.cancelPendingNavigationOnUserScroll, { passive: true }),
      this.scope.on(window, 'touchmove', this.cancelPendingNavigationOnUserScroll, {
        passive: true,
      }),
    ];
  }

  clearPendingNavigation(): void {
    this.revision++;
    this.pendingNavigationId = null;
    void this.stopPendingNavigationTimer?.();
    this.stopPendingNavigationTimer = null;
    for (const stop of this.stopUserScrollListeners.splice(0)) void stop();
  }

  private cancelPendingNavigationOnUserScroll = (): void => {
    this.clearPendingNavigation();
  };

  /**
   * One homing step toward a virtualized-out turn: bisect on the target's
   * position (bounds tightened from which side of the mounted window the turn
   * sits on), jump instantly, and let Claude mount content at the landing
   * point. Once the turn's element is back in the DOM, aim precisely.
   */
  private homePendingNavigation = (): void => {
    this.stopPendingNavigationTimer = null;
    if (!this.pendingNavigationId || this.scope.isDisposed) return;
    if (Date.now() > this.pendingNavigationUntil) {
      trace.homingTimedOut(this.pendingNavigationId);
      this.clearPendingNavigation();
      return;
    }
    const marker = this.actions.markers().find((item) => item.id === this.pendingNavigationId);
    if (!marker) {
      this.clearPendingNavigation();
      return;
    }
    this.actions.lockActive();
    if (marker.element.isConnected) {
      this.clearPendingNavigation();
      scrollElementToAnchor(
        this.actions.scrollTarget(marker.element),
        marker.element,
        this.actions.scrollTop(),
        this.actions.viewportHeight(),
      );
      trace.landed(marker.id, 'homing', this.actions.scrollTop());
      return;
    }
    const mountedIndexes = this.actions.markers().reduce<number[]>((acc, item, index) => {
      if (item.element.isConnected) acc.push(index);
      return acc;
    }, []);
    if (mountedIndexes.length) {
      // Direction info is only trustworthy once the mounted window has caught
      // up with the last jump; otherwise wait a tick instead of moving.
      const windowCurrent = mountedIndexes.some((index) =>
        this.actions.inViewport(this.actions.markers()[index].element),
      );
      if (!windowCurrent) {
        this.schedulePendingNavigationHop();
        return;
      }
      const targetIndex = this.actions.markers().indexOf(marker);
      const firstMounted = mountedIndexes[0];
      const lastMounted = mountedIndexes[mountedIndexes.length - 1];
      if (targetIndex < firstMounted) {
        this.pendingNavigationHi = Math.min(this.pendingNavigationHi, this.actions.scrollTop());
      } else if (targetIndex > lastMounted) {
        this.pendingNavigationLo = Math.max(
          this.pendingNavigationLo,
          this.actions.scrollTop() + this.actions.viewportHeight(),
        );
      } else {
        // Inside a virtualization gap: bracket the target between its nearest
        // mounted neighbours. (A truly deleted turn collapses the bracket and
        // ends the search below.)
        let beforeIndex = -1;
        let afterIndex = -1;
        for (const index of mountedIndexes) {
          if (index < targetIndex) beforeIndex = index;
          else if (index > targetIndex) {
            afterIndex = index;
            break;
          }
        }
        if (beforeIndex >= 0) {
          this.pendingNavigationLo = Math.max(
            this.pendingNavigationLo,
            this.actions.computeCenter(this.actions.markers()[beforeIndex].element),
          );
        }
        if (afterIndex >= 0) {
          this.pendingNavigationHi = Math.min(
            this.pendingNavigationHi,
            this.actions.computeCenter(this.actions.markers()[afterIndex].element),
          );
        }
      }
    }
    if (this.pendingNavigationHi - this.pendingNavigationLo < 1) {
      this.clearPendingNavigation();
      return;
    }
    const staleCenterUsable =
      !this.pendingNavigationProbed &&
      marker.center > this.pendingNavigationLo &&
      marker.center < this.pendingNavigationHi;
    const probe = staleCenterUsable
      ? marker.center
      : (this.pendingNavigationLo + this.pendingNavigationHi) / 2;
    this.pendingNavigationProbed = true;
    scrollToCenter(this.actions.currentTarget(), probe, this.actions.viewportHeight(), 'instant');
    this.schedulePendingNavigationHop();
  };

  private schedulePendingNavigationHop(): void {
    if (this.stopPendingNavigationTimer !== null || this.scope.isDisposed) return;
    this.stopPendingNavigationTimer = this.scope.timer(
      this.homePendingNavigation,
      PENDING_NAVIGATION_HOP_MS,
    );
  }
}
