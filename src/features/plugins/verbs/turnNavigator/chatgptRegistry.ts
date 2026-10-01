import { hashString } from '@/core/utils/hash';
import type { StarredMessage } from '@/pages/content/timeline/starredTypes';

import type {
  ChatGptTimelineSnapshot,
  ChatGptTimelineTurn,
} from '../../sites/adapters/chatgptTurns';

interface DiscoveredTurn {
  readonly id: string;
  readonly nativeId: string | null;
  readonly persistent: boolean;
  readonly hash: string;
  readonly summary: string;
}

export interface ChatGptRegistryMarker extends DiscoveredTurn {
  readonly element: HTMLElement;
  readonly shell: HTMLElement;
  readonly mountedElement: HTMLElement | null;
}

export interface ChatGptResolvedStar {
  readonly storedTurnId: string;
  readonly starredAt: number;
}

const LEGACY_TURN_ID = /^c-(?:\d+-)?([a-z0-9]+)(?:~\d+)?$/i;
const NATIVE_TURN_PREFIX = 'cg-';
const PAGE_TURN_PREFIX = 'ct-';
/** The existing background service stores a 60-character preview followed by three dots. */
const LEGACY_PREVIEW_LENGTH = 60;

export function normalizeChatGptSummary(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function identityKey(turn: ChatGptTimelineTurn): string {
  return `${turn.persistent ? 'native' : 'page'}:${turn.id}`;
}

/** Archive stores data only; visible markers are rebuilt from the current, confirmed shell list. */
export class ChatGptTimelineRegistry {
  private readonly discovered = new Map<string, DiscoveredTurn>();
  private readonly knownRoles = new Map<string, 'user' | 'assistant'>();
  private visible: ChatGptRegistryMarker[] = [];
  private readonly visibleById = new Map<string, ChatGptRegistryMarker>();
  private legacyScopeConfirmed = false;

  reset(): void {
    this.discovered.clear();
    this.knownRoles.clear();
    this.visible = [];
    this.visibleById.clear();
    this.legacyScopeConfirmed = false;
  }

  reconcile(snapshot: ChatGptTimelineSnapshot): readonly ChatGptRegistryMarker[] {
    this.visible = [];
    this.visibleById.clear();
    this.legacyScopeConfirmed = false;
    if (snapshot.status !== 'ready') return this.visible;
    for (const turn of snapshot.turns) {
      const key = identityKey(turn);
      if (turn.role !== 'unknown') {
        const preserveUser =
          this.knownRoles.get(key) === 'user' &&
          turn.role === 'assistant' &&
          turn.container.getAttribute('data-turn') !== 'assistant';
        if (!preserveUser) this.knownRoles.set(key, turn.role);
      }
      const summary = turn.userElement
        ? normalizeChatGptSummary(turn.userElement.textContent ?? '')
        : '';
      if (turn.role === 'user' && summary) {
        this.discovered.set(key, {
          id: `${turn.persistent ? NATIVE_TURN_PREFIX : PAGE_TURN_PREFIX}${turn.id}`,
          nativeId: turn.persistent ? turn.id : null,
          persistent: turn.persistent,
          hash: hashString(summary),
          summary,
        });
      }
      const known = this.discovered.get(key);
      if (!known || this.knownRoles.get(key) !== 'user') continue;
      this.visible.push({
        ...known,
        element: turn.userElement ?? turn.container,
        shell: turn.container,
        mountedElement: turn.userElement,
      });
    }
    for (const marker of this.visible) this.visibleById.set(marker.id, marker);
    this.legacyScopeConfirmed = snapshot.turns.every((turn) => {
      const key = identityKey(turn);
      const role = this.knownRoles.get(key);
      return role === 'assistant' || (role === 'user' && this.discovered.has(key));
    });
    return this.visible;
  }

  findMarker(turnId: string): ChatGptRegistryMarker | undefined {
    const exact = this.visibleById.get(turnId);
    if (exact) return exact;
    const hash = turnId.match(LEGACY_TURN_ID)?.[1];
    return hash ? this.resolveLegacy(hash) : undefined;
  }

  resolveStars(messages: readonly StarredMessage[]): Map<string, ChatGptResolvedStar> {
    const result = new Map<string, ChatGptResolvedStar>();
    const visibleById = this.visibleById;
    for (const message of messages) {
      if (
        !message.turnId.startsWith(NATIVE_TURN_PREFIX) &&
        !message.turnId.startsWith(PAGE_TURN_PREFIX)
      ) {
        continue;
      }
      const marker = visibleById.get(message.turnId);
      if (marker) {
        result.set(marker.id, { storedTurnId: message.turnId, starredAt: message.starredAt });
      }
    }
    const legacyCandidates = new Map<string, StarredMessage[]>();
    for (const message of messages) {
      const hash = message.turnId.match(LEGACY_TURN_ID)?.[1];
      if (!hash) continue;
      const marker = this.resolveLegacy(hash, message.content);
      if (!marker || result.has(marker.id)) continue;
      const candidates = legacyCandidates.get(marker.id) ?? [];
      candidates.push(message);
      legacyCandidates.set(marker.id, candidates);
    }
    for (const [markerId, candidates] of legacyCandidates) {
      if (candidates.length !== 1) continue;
      result.set(markerId, {
        storedTurnId: candidates[0].turnId,
        starredAt: candidates[0].starredAt,
      });
    }
    return result;
  }

  private resolveLegacy(hash: string, content?: string): ChatGptRegistryMarker | undefined {
    if (!this.legacyScopeConfirmed || (content !== undefined && !normalizeChatGptSummary(content)))
      return undefined;
    // An archived same-text turn is still an ambiguity; a branch switch does not erase it.
    const candidates = Array.from(this.discovered.values()).filter((turn) => turn.hash === hash);
    if (candidates.length !== 1 || !candidates[0].persistent) return undefined;
    if (content !== undefined) {
      const normalized = normalizeChatGptSummary(content);
      const summary = candidates[0].summary;
      const truncatedPreview =
        content.length === LEGACY_PREVIEW_LENGTH + 3 &&
        content.endsWith('...') &&
        summary.startsWith(normalizeChatGptSummary(content.slice(0, LEGACY_PREVIEW_LENGTH)));
      if (summary !== normalized && !truncatedPreview) return undefined;
    }
    return this.visible.find((marker) => marker.id === candidates[0].id);
  }
}
