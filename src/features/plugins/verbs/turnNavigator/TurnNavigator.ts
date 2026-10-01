/** Composes scoped conversation identity, registry, rail and navigation owners. */
import { StorageKeys, type TimelineStyle } from '@/core/types/common';
import { type Dispose, PluginScope } from '@/features/plugins/runtime/pluginScope';
import { setPluginSetting } from '@/features/plugins/storage/pluginState';
import type { PluginSettings } from '@/features/plugins/types';
import { StarredMessagesService } from '@/pages/content/timeline/StarredMessagesService';
import { TimelinePreviewPanel } from '@/pages/content/timeline/TimelinePreviewPanel';
import type { StarredMessage } from '@/pages/content/timeline/starredTypes';
import { showTimelineStyleCoachmark } from '@/pages/content/timeline/timelineStyleCoachmark';
import type { PreviewMarkerData } from '@/pages/content/timeline/types';
import { watchRouteChanges } from '@/pages/content/utils/routeWatcher';
import { initI18n, getTranslationSync } from '@/utils/i18n';

import { ChatGptTimelineProvider } from '../../sites/adapters/chatgptTurns';
import { observeNewConversationSubmission } from '../../sites/adapters/newConversationHandoff';
import { ChatGptNavigationController } from './chatgptNavigation';
import { ChatGptTimelineRegistry } from './chatgptRegistry';
import { buildConversationId } from './conversationIdentity';
import { ConversationSession } from './conversationSession';
import { NavigationFeedback } from './navigationFeedback';
import { showTurnTooltip } from './tooltipPresentation';
export {
  buildConversationId,
  buildTurnId,
  buildClaudeConversationId,
  buildClaudeTurnId,
  extractClaudeTurnHash,
  hasOpenClaudeArtifact,
} from './conversationIdentity';
import type { PrimitiveHandle } from '../types';
import { readingMarkerId } from './activeMarker';
import { LegacyNavigationController } from './legacyNavigation';
import { mergeLegacyTurns } from './legacyRegistry';
import type { Dot, Marker } from './markerTypes';
import * as trace from './navTrace';
import { renderTimelineDots, compactMarkerOffsets } from './railRendering';
import * as geom from './scrollGeometry';
import { isReverseScroller } from './scrollMotion';
import { extractTurnHash, StarSnapshotLoader } from './starSnapshot';
import { TimelineLayoutObserver } from './timelineLayout';
export { extractTurnHash } from './starSnapshot';

export interface TurnNavigatorConfig {
  /** Site adapter id; prefixes conversation ids and marks the rail. */
  readonly siteId: string;
  /** Display label, stripped from `document.title` for starred-message titles. */
  readonly siteLabel: string;
  readonly turnSelector: string;
  /** Path regular expression whose first group is the conversation id. */
  readonly conversationIdPattern?: string;
  readonly scrollContainerSelector?: string;
  readonly yieldWhenSelector?: string;
  readonly position: 'left' | 'right';
  /** Plugin whose `compactView` setting the onboarding guide writes. */
  readonly pluginId: string;
  readonly coachmarkId: string;
}

/** Shared guide ID preserves Claude's existing COACHMARKS_SEEN key across sites. */
export const TIMELINE_STYLE_COACHMARK_ID = 'claude-timeline-compact-style-intro-v1';

export const TURN_ID_ATTR = 'data-gv-turn-id';
const TOOLTIP_ID = 'gv-turn-navigator-tooltip';
const TOOLTIP_TEXT_CLASS = 'gv-turn-navigator-tooltip-text';
const REFRESH_DELAY_MS = 120;
const LONG_PRESS_MS = 550;
const ACTIVE_ANCHOR = 0.45;
const NAVIGATION_ACTIVE_LOCK_MS = 900;
const TOOLTIP_DELAY_MS = 150;
const COMPACT_VIEW_SETTING = 'compactView';

export class TurnNavigator {
  private bar: HTMLElement | null = null;
  private trackContent: HTMLElement | null = null;
  private tooltip: HTMLElement | null = null;
  private previewPanel: TimelinePreviewPanel | null = null;
  private observing = false;
  private markers: Marker[] = [];
  private markerCenters: number[] = [];
  private conversationId = '';
  private readonly starSnapshots = new StarSnapshotLoader();
  private starredByHash = new Map<string, { turnId: string; starredAt: number }>();
  private stopRefreshTimer: Dispose | null = null;
  private stopLongPressTimer: Dispose | null = null;
  private stopTooltipTimer: Dispose | null = null;
  private longPressDot: Dot | null = null;
  private suppressClickUntil = 0;
  private activeTurnId: string | null = null;
  private timelineStyle: TimelineStyle = 'dots';
  private navigationActiveLockUntil = 0;
  private lastHandledHash: string | null = null;
  private scrollTarget: HTMLElement | Window | null = null;
  /** Resolved with the target: `column-reverse` containers need offset translation. */
  private scrollTargetReversed = false;
  private stopScrollListener: Dispose | null = null;

  private readonly session = new ConversationSession();
  private readonly legacyNavigation: LegacyNavigationController;
  private readonly chatgptProvider: ChatGptTimelineProvider | null;
  private readonly chatgptRegistry: ChatGptTimelineRegistry | null;
  private readonly chatgptNavigation: ChatGptNavigationController | null;
  private readonly feedback: NavigationFeedback;
  private readonly ownerId = crypto.randomUUID();
  private starMessages: StarredMessage[] = [];
  private temporaryStars: StarredMessage[] = [];
  private promotionStars: StarredMessage[] = [];
  private loadedStarSession = '';
  private layoutRoot: HTMLElement | null = null;
  private layoutObserver: TimelineLayoutObserver | null = null;
  private stopLayout: Dispose | null = null;
  private stopLayoutFrame: Dispose | null = null;

  constructor(
    private readonly scope: PluginScope,
    private readonly config: TurnNavigatorConfig,
    provider?: ChatGptTimelineProvider,
  ) {
    this.feedback = new NavigationFeedback(scope);
    this.chatgptProvider =
      config.siteId === 'chatgpt' ? (provider ?? new ChatGptTimelineProvider()) : null;
    this.chatgptRegistry = this.chatgptProvider ? new ChatGptTimelineRegistry() : null;
    this.legacyNavigation = new LegacyNavigationController(scope, {
      findMarker: (id) => this.findMarker(id),
      markers: () => this.markers,
      computeCenter: (element) => this.computeElementCenter(element),
      viewportHeight: () => this.getViewportHeight(),
      scrollTop: () => this.getScrollTop(),
      scrollHeight: () => this.getScrollHeight(),
      scrollTarget: (element) => this.getScrollTarget(element),
      currentTarget: () => this.scrollTarget,
      inViewport: (element) => this.isElementInViewport(element),
      lockActive: () => {
        this.navigationActiveLockUntil = Date.now() + NAVIGATION_ACTIVE_LOCK_MS;
      },
      setActive: (id) => this.setActiveTurn(id),
    });
    this.chatgptNavigation = this.chatgptProvider
      ? new ChatGptNavigationController(scope, {
          isCurrent: (token) =>
            !this.disposed && !this.syncConversation() && this.session.isCurrent(token),
          resolve: (id) => {
            const snapshot = this.chatgptProvider!.snapshot(this.session.token);
            this.chatgptRegistry!.reconcile(snapshot);
            const marker = this.chatgptRegistry!.findMarker(id);
            return snapshot.root && marker
              ? {
                  element: marker.element,
                  mounted: !!marker.mountedElement?.isConnected,
                  root: snapshot.root,
                }
              : null;
          },
          scrollTarget: (element) => {
            const target = this.getScrollTarget(element);
            this.setScrollTarget(target);
            return target;
          },
          state: (state, id) => {
            const token = this.session.token;
            this.feedback.show(state, () => {
              if (!this.syncConversation() && this.session.isCurrent(token)) this.navigateTo(id);
            });
            this.navigationActiveLockUntil = state === 'pending' ? Number.POSITIVE_INFINITY : 0;
            this.markers.forEach((marker) => marker.dotElement?.removeAttribute('aria-busy'));
            if (state === 'pending' || state === 'success') this.setActiveTurn(id);
            if (state === 'pending')
              this.findMarker(id)?.dotElement?.setAttribute('aria-busy', 'true');
            else this.updateActiveFromScroll();
            if (state === 'success') trace.landed(id, 'anchor', this.getScrollTop());
            if (state === 'unavailable') trace.homingTimedOut(id);
          },
        })
      : null;
  }

  /** `<siteId>:conv:<id>` from the site's route pattern, else a hash of the path. */
  private buildConversationId(input: string = location.href): string {
    return buildConversationId(this.config, input);
  }

  /** The onboarding guide stays closed while the yield selector matches. */
  private shouldYield(): boolean {
    const selector = this.config.yieldWhenSelector;
    if (!selector) return false;
    try {
      return !!document.querySelector(selector);
    } catch {
      return false;
    }
  }

  private get disposed(): boolean {
    return this.scope.isDisposed;
  }

  async start(settings: PluginSettings = {}): Promise<void> {
    this.updateSettings(settings);
    if (this.chatgptProvider) observeNewConversationSubmission(this.scope, this.chatgptProvider);
    // Markers stamp `data-gv-turn-id` onto the site's own turn nodes; roll
    // every stamp back when the plugin unmounts.
    this.scope.effect(
      () => () => {
        document.querySelectorAll<HTMLElement>('[data-gv-turn-owner]').forEach((element) => {
          if (element.dataset.gvTurnOwner !== this.ownerId) return;
          element.removeAttribute(TURN_ID_ATTR);
          element.removeAttribute('data-gv-turn-owner');
        });
      },
      'turn-id-attrs',
    );
    this.scope.effect(
      () =>
        watchRouteChanges(() => {
          if (this.syncConversation()) this.scheduleRefresh();
        }),
      'timeline-route',
    );
    await initI18n().catch(() => {});
    if (this.disposed) return;
    trace.started(this.config, this.buildConversationId());
    this.ensureUi();
    await this.refresh();
    if (this.disposed) return;
    this.observe();
    this.scope.on(window, 'hashchange', this.handleHash);
    this.scope.on(window, 'resize', this.handleResize);
    this.maybeShowStyleCoachmark();
  }

  updateSettings(settings: PluginSettings): void {
    const nextStyle: TimelineStyle = settings[COMPACT_VIEW_SETTING] === true ? 'compact' : 'dots';
    const changed = this.timelineStyle !== nextStyle;
    this.timelineStyle = nextStyle;
    this.applyTimelineStyle();
    if (changed && this.markers.length > 0) this.renderDots();
  }

  private maybeShowStyleCoachmark(): void {
    if (this.disposed || this.timelineStyle === 'compact') return;
    // Never open a scrimmed guide over an active artifact: the panel is part
    // of the top document view. Skipping does NOT burn the once-per-user seen
    // state, so the guide simply shows on a later artifact-free page load.
    if (this.shouldYield()) return;
    void showTimelineStyleCoachmark({
      id: this.config.coachmarkId,
      enabled: false,
      // A disposed scope aborts the signal, closing an in-flight guide.
      signal: this.scope.signal,
      onStyleChange: async (compact) => {
        if (this.disposed) return;
        this.updateSettings({ [COMPACT_VIEW_SETTING]: compact });
        await setPluginSetting(this.config.pluginId, COMPACT_VIEW_SETTING, compact);
      },
    });
  }

  private observe(): void {
    if (!document.body || this.observing) return;
    this.observing = true;
    this.scope.observe(
      document.body,
      {
        childList: true,
        subtree: true,
        characterData: !!this.chatgptProvider,
        ...(this.chatgptProvider
          ? {
              attributes: true,
              attributeFilter: [
                'data-turn-key',
                'data-turn-id-container',
                'data-turn',
                'data-message-author-role',
                'hidden',
                'aria-hidden',
                'inert',
              ],
            }
          : {}),
      },
      (records) => {
        if (!records.some((record) => this.shouldRefreshForMutation(record))) return;
        this.scheduleRefresh();
      },
    );

    if (chrome.storage?.onChanged) {
      this.scope.onChromeEvent(
        chrome.storage.onChanged,
        (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
          if (areaName !== 'local' || !changes[StorageKeys.TIMELINE_STARRED_MESSAGES]) return;
          this.syncConversation();
          void this.loadStars(true).then(() => {
            if (!this.disposed) this.applyStarredState();
          });
        },
      );
    }
  }

  private isOwnMutation(record: MutationRecord): boolean {
    const nodes = [
      record.target,
      ...Array.from(record.addedNodes),
      ...Array.from(record.removedNodes),
    ];
    return nodes.every((node) => {
      const element =
        node instanceof window.Element
          ? node
          : node.parentElement instanceof window.Element
            ? node.parentElement
            : null;
      return !!element?.closest(
        '[data-gv-turn-navigator], .timeline-preview-panel, .timeline-preview-toggle, .gv-timeline-navigation-status',
      );
    });
  }

  private shouldRefreshForMutation(record: MutationRecord): boolean {
    if (this.isOwnMutation(record)) return false;
    if (this.chatgptProvider)
      return (
        record.type !== 'characterData' ||
        !!this.toElement(record.target)?.closest(this.config.turnSelector)
      );
    return (
      !!this.toElement(record.target)?.closest(this.config.turnSelector) ||
      [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some((node) =>
        this.touchesTurn(node),
      )
    );
  }

  private touchesTurn(node: Node): boolean {
    const element = this.toElement(node);
    return !!(
      element?.closest(this.config.turnSelector) ||
      element?.querySelector?.(this.config.turnSelector)
    );
  }

  private toElement(node: Node): Element | null {
    return node instanceof window.Element
      ? node
      : node.parentElement instanceof window.Element
        ? node.parentElement
        : null;
  }

  private ensureUi(): void {
    let bar = this.bar?.isConnected ? this.bar : null;
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'gemini-timeline-bar';
      bar.dataset.gvTurnNavigator = this.config.siteId;
      if (this.config.position === 'left') {
        bar.dataset.gvPosition = 'left';
        bar.style.right = 'auto';
        bar.style.left = '15px';
      }
      const track = document.createElement('div');
      track.className = 'timeline-track';
      const content = document.createElement('div');
      content.className = 'timeline-track-content';
      track.appendChild(content);
      bar.appendChild(track);
      this.scope.mount(bar, document.body);
    }
    this.bar = bar;
    this.trackContent = bar.querySelector('.timeline-track-content') as HTMLElement | null;
    if (!this.tooltip) {
      const tooltip = document.createElement('div');
      tooltip.id = TOOLTIP_ID;
      tooltip.className = 'timeline-tooltip';
      tooltip.setAttribute('aria-hidden', 'true');
      const text = document.createElement('div');
      text.className = TOOLTIP_TEXT_CLASS;
      tooltip.appendChild(text);
      this.scope.mount(tooltip, document.body);
      this.tooltip = tooltip;
    }
    if (!this.previewPanel) {
      this.previewPanel = new TimelinePreviewPanel(bar, {
        virtualizeLongLists: !!this.chatgptProvider,
        historyNotice: this.chatgptProvider
          ? getTranslationSync('timelineHistoryLoadedOnly')
          : undefined,
      });
      this.previewPanel.init(
        (turnId) => this.navigateTo(turnId),
        undefined,
        (turnId) => this.toggleStar(turnId),
      );
      // The panel manages its own timers/listeners/DOM; adopt its destroy().
      this.scope.child(this.previewPanel, 'preview-panel');
    }
    this.applyTimelineStyle();
    this.setSurfaceVisible();
  }

  private applyTimelineStyle(): void {
    if (!this.bar) return;
    const compact = this.timelineStyle === 'compact';
    this.bar.classList.toggle('timeline-style-compact', compact);
    if (this.chatgptProvider) this.bar.classList.toggle('timeline-no-container', compact);
    const track = this.trackContent?.parentElement;
    if (compact) {
      if (!this.chatgptProvider) track?.setAttribute('aria-hidden', 'true');
      else track?.removeAttribute('aria-hidden');
      this.hideTooltip();
    } else {
      track?.removeAttribute('aria-hidden');
    }
    this.previewPanel?.setCompactMode(compact);
  }

  private scheduleRefresh(): void {
    if (this.disposed) return;
    void this.stopRefreshTimer?.();
    this.stopRefreshTimer = this.scope.timer(() => {
      this.stopRefreshTimer = null;
      void this.refresh();
    }, REFRESH_DELAY_MS);
  }

  private syncConversation(): boolean {
    const id = this.buildConversationId();
    const previousStorageId = this.session.storageId;
    if (!this.session.sync(id, location.href, !!this.chatgptProvider)) return false;
    const promotion =
      this.chatgptProvider && !previousStorageId && this.session.storageId
        ? [...this.temporaryStars]
        : [];
    this.conversationId = id;
    this.resetConversationState();
    this.promotionStars = promotion;
    return true;
  }

  private setSurfaceVisible(): void {
    if (!this.chatgptProvider) return;
    const visible = this.markers.length > 0;
    if (this.bar) this.bar.hidden = !visible;
    this.previewPanel?.setSurfaceVisible(visible);
    if (!visible) this.hideTooltip();
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return;
    const changed = this.syncConversation();
    this.ensureUi();
    const token = this.session.token;
    const previous = new Map(this.markers.map((marker) => [marker.id, marker]));
    let root: HTMLElement | null = null;
    if (this.chatgptProvider && this.chatgptRegistry) {
      const snapshot = this.chatgptProvider.snapshot(token);
      root = snapshot.root;
      if (
        !this.session.storageId &&
        snapshot.status === 'ready' &&
        !snapshot.turns.length &&
        this.markers.length
      ) {
        this.session.restart();
        this.resetConversationState();
        this.scheduleRefresh();
        return;
      }
      this.markers = this.chatgptRegistry.reconcile(snapshot).map((entry) => {
        const marker = previous.get(entry.id) ?? {
          ...entry,
          starred: false,
          center: 0,
          dotElement: null,
        };
        Object.assign(marker, entry);
        return marker;
      });
      if (snapshot.status === 'pending' || (this.layoutRoot && this.layoutRoot !== root)) {
        this.chatgptNavigation?.cancel();
        this.feedback.clear();
      }
      if (snapshot.status === 'pending') this.previewPanel?.resetConversation();
    } else {
      const turns = Array.from(document.querySelectorAll<HTMLElement>(this.config.turnSelector));
      this.markers = this.mergeMountedTurns(turns);
    }
    if (!this.session.isCurrent(token) || this.disposed) return;
    if (this.markers[0]) this.setScrollTarget(this.getScrollTarget(this.markers[0].element));
    for (const marker of this.markers) {
      marker.element.dataset.gvTurnId = marker.id;
      marker.element.dataset.gvTurnOwner = this.ownerId;
    }
    this.bindLayout(root);
    this.markerCenters = this.computeMarkerCenters();
    this.renderDots();
    this.applyStarredState();
    this.setSurfaceVisible();
    this.refreshActive();
    this.handleHash();
    void this.loadStars().then(() => {
      if (!this.disposed && !this.syncConversation() && this.session.isCurrent(token))
        this.applyStarredState();
    });
    if (this.promotionStars.length && this.session.storageId && this.markers.length) {
      const promotion = this.promotionStars;
      this.promotionStars = [];
      this.starSnapshots.begin(() => false);
      const conversationId = this.session.storageId;
      for (const message of promotion) {
        if (!this.markers.some((marker) => marker.persistent && marker.id === message.turnId))
          continue;
        const saved = { ...message, conversationId, conversationUrl: location.href.split('#')[0] };
        this.starMessages.push(saved);
        void StarredMessagesService.addStarredMessage(saved).then(() => {
          if (this.session.isCurrent(token) && !this.disposed) {
            void this.loadStars(true).then(() => this.applyStarredState());
          }
        });
      }
      this.applyStarredState();
    }
    trace.turns(
      this.config,
      this.conversationId,
      changed,
      this.markers.filter((marker) => marker.element.isConnected).length,
      this.markers,
    );
  }

  private bindLayout(root: HTMLElement | null): void {
    if (!this.chatgptProvider) return;
    if (root === this.layoutRoot) {
      this.layoutObserver?.update(this.markers);
      return;
    }
    void this.stopLayout?.();
    this.stopLayout = null;
    this.layoutRoot = root;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const token = this.session.token;
    const update = (): void => {
      if (this.stopLayoutFrame || this.disposed) return;
      this.stopLayoutFrame = this.scope.frame(() => {
        this.stopLayoutFrame = null;
        if (this.syncConversation() || !this.session.isCurrent(token)) return;
        if (this.markers[0]) this.setScrollTarget(this.getScrollTarget(this.markers[0].element));
        this.markerCenters = this.computeMarkerCenters();
        this.applyCompactOffsets();
        this.updateActiveFromScroll();
        this.previewPanel?.reposition();
      });
    };
    this.layoutObserver = new TimelineLayoutObserver(this.scope, root, update);
    this.stopLayout = this.layoutObserver.stop;
    this.layoutObserver.update(this.markers);
  }

  private resetConversationState(): void {
    this.starSnapshots.begin(() => false);
    this.loadedStarSession = '';
    this.clearPendingNavigation();
    this.cancelLongPress();
    this.hideTooltip();
    void this.stopRefreshTimer?.();
    this.stopRefreshTimer = null;
    void this.stopLayout?.();
    this.stopLayout = null;
    void this.stopLayoutFrame?.();
    this.stopLayoutFrame = null;
    this.layoutRoot = null;
    this.layoutObserver = null;
    this.setScrollTarget(null);
    this.chatgptRegistry?.reset();
    this.starMessages = [];
    this.temporaryStars = [];
    this.promotionStars = [];
    this.starredByHash.clear();
    this.markers = [];
    this.markerCenters = [];
    this.activeTurnId = null;
    this.navigationActiveLockUntil = 0;
    this.suppressClickUntil = 0;
    this.lastHandledHash = null;
    this.feedback.clear();
    this.previewPanel?.resetConversation();
    if (this.trackContent) this.trackContent.textContent = '';
    this.setSurfaceVisible();
  }

  private mergeMountedTurns(turns: HTMLElement[]): Marker[] {
    return mergeLegacyTurns(
      this.markers,
      turns,
      (element) => this.extractText(element),
      (element) => this.computeElementCenter(element),
    );
  }

  private async loadStars(force = false): Promise<void> {
    const id = this.session.storageId;
    const token = this.session.token;
    if (!id || (!force && this.loadedStarSession === token)) return;
    this.loadedStarSession = token;
    const isCurrent = this.starSnapshots.begin(
      () => !this.disposed && this.session.isCurrent(token) && this.buildConversationId() === id,
    );
    const messages = await StarredMessagesService.getStarredMessagesForConversation(id);
    if (!isCurrent()) return;
    this.starMessages = messages;
    if (!this.chatgptRegistry)
      this.starredByHash = new Map(
        messages.map((message) => [
          extractTurnHash(message.turnId),
          { turnId: message.turnId, starredAt: message.starredAt },
        ]),
      );
  }

  private renderDots(): void {
    if (!this.trackContent) return;
    renderTimelineDots(this.trackContent, this.markers, this.timelineStyle, {
      activeId: () => this.activeTurnId,
      suppressed: () => Date.now() < this.suppressClickUntil,
      navigate: (id) => this.navigateTo(id),
      longPress: (dot) => this.startLongPress(dot),
      cancelLongPress: () => this.cancelLongPress(),
      scheduleTooltip: (dot) => this.scheduleTooltip(dot),
      showTooltip: (dot) => this.showTooltip(dot),
      hideTooltip: () => this.hideTooltip(),
    });
  }

  private applyCompactOffsets(): void {
    if (this.timelineStyle !== 'compact') return;
    const offsets = compactMarkerOffsets(
      this.markers.length,
      this.trackContent?.parentElement?.clientHeight ?? 0,
    );
    this.markers.forEach((marker, index) =>
      marker.dotElement?.style.setProperty('--timeline-compact-offset', `${offsets[index] ?? 0}px`),
    );
  }

  private startLongPress(dot: Dot): void {
    this.cancelLongPress();
    if (this.disposed) return;
    this.longPressDot = dot;
    dot.classList.add('holding');
    const token = this.session.token;
    this.stopLongPressTimer = this.scope.timer(() => {
      if (this.syncConversation() || !this.session.isCurrent(token) || !dot.isConnected) return;
      this.stopLongPressTimer = null;
      this.suppressClickUntil = Date.now() + 350;
      const id = dot.dataset.targetTurnId;
      if (id) void this.toggleStar(id);
      this.cancelLongPress();
    }, LONG_PRESS_MS);
  }

  private cancelLongPress(): void {
    void this.stopLongPressTimer?.();
    this.stopLongPressTimer = null;
    this.longPressDot?.classList.remove('holding');
    this.longPressDot = null;
  }

  private async toggleStar(turnId: string): Promise<void> {
    if (this.syncConversation()) return;
    const token = this.session.token;
    const marker = this.findMarker(turnId);
    if (!marker) return;
    const id = this.session.storageId;
    if (this.chatgptRegistry) {
      // A read begun before this local change must not restore the previous value.
      this.starSnapshots.begin(() => false);
      const persisted = !!id && !!marker.persistent;
      const records = persisted ? this.starMessages : this.temporaryStars;
      const existing = this.chatgptRegistry.resolveStars(records).get(marker.id);
      if (existing) {
        if (persisted)
          this.starMessages = records.filter((message) => message.turnId !== existing.storedTurnId);
        else
          this.temporaryStars = records.filter(
            (message) => message.turnId !== existing.storedTurnId,
          );
        this.applyStarredState();
        if (persisted)
          await StarredMessagesService.removeStarredMessage(id!, existing.storedTurnId);
      } else {
        const message: StarredMessage = {
          turnId: marker.id,
          content: marker.summary,
          conversationId: id ?? this.session.token,
          conversationUrl: location.href.split('#')[0],
          conversationTitle: this.getTitle(),
          starredAt: Date.now(),
        };
        if (id && marker.persistent) {
          this.starMessages.push(message);
          this.applyStarredState();
          await StarredMessagesService.addStarredMessage(message);
        } else {
          this.temporaryStars.push(message);
          this.applyStarredState();
        }
      }
    } else {
      const existing = this.starredByHash.get(marker.hash);
      if (existing) {
        this.starredByHash.delete(marker.hash);
        await StarredMessagesService.removeStarredMessage(this.conversationId, existing.turnId);
      } else {
        const starredAt = Date.now();
        this.starredByHash.set(marker.hash, { turnId: marker.id, starredAt });
        await StarredMessagesService.addStarredMessage({
          turnId: marker.id,
          content: marker.summary,
          conversationId: this.conversationId,
          conversationUrl: location.href.split('#')[0],
          conversationTitle: this.getTitle(),
          starredAt,
        });
      }
    }
    if (!this.disposed && !this.syncConversation() && this.session.isCurrent(token))
      this.applyStarredState();
  }

  private applyStarredState(): void {
    const resolved = this.chatgptRegistry?.resolveStars([
      ...this.starMessages,
      ...this.temporaryStars,
    ]);
    this.markers.forEach((marker) => {
      const entry = resolved ? resolved.get(marker.id) : this.starredByHash.get(marker.hash);
      marker.starred = !!entry;
      marker.starredAt = entry?.starredAt;
      marker.dotElement?.classList.toggle('starred', marker.starred);
      marker.dotElement?.setAttribute('aria-pressed', marker.starred ? 'true' : 'false');
    });
    this.updatePreview();
  }

  private updatePreview(): void {
    const previewMarkers: PreviewMarkerData[] = this.markers.map((marker, index) => ({
      id: marker.id,
      summary: marker.summary,
      index,
      starred: marker.starred,
      starredAt: marker.starredAt,
    }));
    this.previewPanel?.updateMarkers(previewMarkers);
    this.previewPanel?.updateActiveTurn(this.activeTurnId);
  }

  private setActiveTurn(turnId: string | null): void {
    if (this.activeTurnId === turnId) return;
    const previousTurnId = this.activeTurnId;
    this.activeTurnId = turnId;
    this.updateDotActive(previousTurnId, false);
    this.updateDotActive(turnId, true);
    this.previewPanel?.updateActiveTurn(turnId);
  }

  private updateDotActive(turnId: string | null, active: boolean): void {
    const dot = this.markers.find((marker) => marker.id === turnId)?.dotElement;
    dot?.classList.toggle('active', active);
    dot?.setAttribute('aria-current', active ? 'true' : 'false');
  }

  private scheduleTooltip(dot: Dot): void {
    // Compact ticks are clickable but stay quiet: the preview panel already
    // lists every turn while the rail is hovered.
    if (this.disposed || this.timelineStyle === 'compact') return;
    void this.stopTooltipTimer?.();
    this.stopTooltipTimer = this.scope.timer(() => {
      this.stopTooltipTimer = null;
      this.showTooltip(dot);
    }, TOOLTIP_DELAY_MS);
  }

  private showTooltip(dot: Dot): void {
    if (!this.tooltip || !dot.isConnected || this.timelineStyle === 'compact') return;
    const marker = this.markers.find((item) => item.id === dot.dataset.targetTurnId);
    if (!marker?.summary) return;

    showTurnTooltip(this.tooltip, dot, marker.summary, marker.starred);
  }

  private hideTooltip(): void {
    void this.stopTooltipTimer?.();
    this.stopTooltipTimer = null;
    this.tooltip?.classList.remove('visible');
    this.tooltip?.setAttribute('aria-hidden', 'true');
  }

  private refreshActive(): void {
    if (this.chatgptProvider) {
      this.updateActiveFromScroll();
      return;
    }
    if (this.activeTurnId && this.markers.some((marker) => marker.id === this.activeTurnId)) {
      this.updateDotActive(this.activeTurnId, true);
      return;
    }
    this.updateActiveFromScroll();
  }

  private updateActiveFromScroll = (): void => {
    if (!this.markers.length) {
      this.setActiveTurn(null);
      return;
    }
    if (Date.now() < this.navigationActiveLockUntil) return;
    if (this.isAtScrollBottom()) {
      this.setActiveTurn(this.markers[this.markers.length - 1]?.id ?? null);
      return;
    }
    const anchor = this.getViewportHeight() * ACTIVE_ANCHOR;
    this.setActiveTurn(
      readingMarkerId(
        this.markers,
        this.markerCenters,
        this.getScrollTop() + anchor,
        this.chatgptProvider ? this.getViewportTop() + anchor : undefined,
      ),
    );
  };

  private setScrollTarget(target: HTMLElement | Window | null): void {
    this.scrollTargetReversed = isReverseScroller(target);
    if (this.scrollTarget === target) return;
    void this.stopScrollListener?.();
    this.stopScrollListener = null;
    this.scrollTarget = target;
    this.scrollTargetReversed = isReverseScroller(target);
    trace.scrollTarget(this.config, target, this.scrollTargetReversed);
    if (target && !this.disposed) {
      this.stopScrollListener = this.scope.on(target, 'scroll', this.updateActiveFromScroll, {
        passive: true,
      });
    }
  }

  private findMarker(turnId: string): Marker | undefined {
    if (this.chatgptRegistry) {
      const entry = this.chatgptRegistry.findMarker(turnId);
      return entry ? this.markers.find((marker) => marker.id === entry.id) : undefined;
    }
    return (
      this.markers.find((item) => item.id === turnId) ??
      this.markers.find((item) => item.hash === extractTurnHash(turnId))
    );
  }

  private navigateTo(turnId: string): void {
    if (this.syncConversation()) return;
    if (this.chatgptNavigation) {
      const marker = this.findMarker(turnId);
      if (!marker) return;
      this.chatgptNavigation.start(marker.id, this.session.token);
    } else this.legacyNavigation.navigateTo(turnId);
  }

  private clearPendingNavigation(): void {
    this.legacyNavigation.clearPendingNavigation();
    this.chatgptNavigation?.cancel();
  }

  private isElementInViewport(element: HTMLElement): boolean {
    const top = this.getViewportTop();
    return geom.elementInViewport(element, top, top + this.getViewportHeight());
  }

  private handleHash = (): void => {
    const hash = location.hash;
    if (!hash.startsWith('#gv-turn-') || hash === this.lastHandledHash) return;
    let turnId: string;
    try {
      turnId = decodeURIComponent(hash.slice('#gv-turn-'.length));
    } catch {
      return;
    }
    if (!turnId) return;
    const marker = this.findMarker(turnId);
    // Not discovered yet (virtualized out and never mounted): leave the hash
    // unconsumed so later refreshes retry once the turn appears.
    if (!marker) return;
    this.lastHandledHash = hash;
    this.navigateTo(marker.id);
  };

  private handleResize = (): void => {
    this.applyCompactOffsets();
    this.scheduleRefresh();
    this.previewPanel?.reposition();
  };

  private extractText(element: HTMLElement): string {
    return (element.textContent || '').replace(/\s+/g, ' ').trim();
  }

  private getTitle(): string {
    const label = this.config.siteLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const title = document.title.replace(new RegExp(`\\s*[|-]\\s*${label}.*$`, 'i'), '').trim();
    return (
      title || this.markers[0]?.summary.slice(0, 50) || `${this.config.siteLabel} conversation`
    );
  }

  private getScrollTarget(element: HTMLElement): HTMLElement | Window {
    const configured = this.config.scrollContainerSelector;
    if (configured) {
      try {
        const container = document.querySelector<HTMLElement>(configured);
        if (container && container.contains(element)) return container;
      } catch {
        // Invalid selector from a site file: fall back to auto-detection.
      }
    }
    for (let parent = element.parentElement; parent && parent !== document.body;) {
      const style = getComputedStyle(parent);
      if (
        /(auto|scroll|overlay)/.test(style.overflowY) &&
        parent.scrollHeight > parent.clientHeight
      )
        return parent;
      parent = parent.parentElement;
    }
    return window;
  }

  private computeMarkerCenters(): number[] {
    const scrollTop = this.getScrollTop();
    const viewportTop = this.getViewportTop();
    const centers: number[] = [];
    for (const marker of this.markers) {
      if (marker.element.isConnected) {
        marker.center = this.computeElementCenter(marker.element, scrollTop, viewportTop);
      }
      // Keep the array monotonic for the active-turn binary search: stale
      // centers of virtualized-out turns can lag behind re-measured neighbours.
      const previous = centers[centers.length - 1];
      centers.push(previous !== undefined && marker.center < previous ? previous : marker.center);
    }
    return centers;
  }

  private computeElementCenter(
    element: HTMLElement,
    scrollTop = this.getScrollTop(),
    viewportTop = this.getViewportTop(),
  ): number {
    return geom.elementCenter(element, scrollTop, viewportTop);
  }

  private getViewportTop(): number {
    return geom.viewportTop(this.scrollTarget);
  }

  /** The reading offset every position in this class is compared in. */
  private getScrollTop(): number {
    return geom.readingScrollTop(this.scrollTarget, this.scrollTargetReversed);
  }

  private getViewportHeight(): number {
    return geom.viewportHeight(this.scrollTarget);
  }

  private getScrollHeight(): number {
    return geom.contentHeight(this.scrollTarget);
  }

  private isAtScrollBottom(): boolean {
    return geom.readingAtBottom(this.scrollTarget, this.scrollTargetReversed);
  }
}

/**
 * Run a navigator under `scope`; the returned handle applies setting changes
 * in place (the rail and its grow-only markers survive a compact toggle).
 */
export function activateTurnNavigator(
  scope: PluginScope,
  config: TurnNavigatorConfig,
  settings: PluginSettings = {},
  provider?: ChatGptTimelineProvider,
): PrimitiveHandle {
  const navigator = new TurnNavigator(scope, config, provider);
  // Startup registers as a pending effect: dispose() barriers on it, and a
  // mid-startup unmount is handled by the scope instead of a destroyed flag.
  scope.effect(() => navigator.start(settings).then(() => () => {}), 'turn-navigator-start');
  return {
    updateSettings: (next) => navigator.updateSettings(next),
  };
}
