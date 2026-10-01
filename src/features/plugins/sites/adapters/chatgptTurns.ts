import { NewConversationHandoff } from './newConversationHandoff';

/** ChatGPT DOM knowledge shared by timeline and export, without either feature's runtime. */
export const CHATGPT_TURN_CONTAINER_SELECTOR = '[data-turn-id-container]';
export const CHATGPT_USER_MESSAGE_SELECTOR = '[data-message-author-role="user"]';
export const CHATGPT_ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';
export const CHATGPT_IMAGEGEN_SELECTOR = '[class*="group/imagegen-image"]';

const TURN_FRAME_SELECTOR = '[data-turn]';
const USER_BUBBLE_SELECTOR = '[data-user-message-bubble]';
const TURN_KEY_SELECTOR = '[data-turn-key]';
const SEARCH_MESSAGE_IDS_SELECTOR = '[data-chatgpt-search-message-ids]';
const MODERN_ASSISTANT_SELECTOR = '[data-chatgpt-selection-message-id]';
const NATIVE_UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
/** Both client-created and paginated roots are list bookkeeping, not messages. */
const NON_TURN_CONTAINER_ID = /-root(?::|$)/;
const CONVERSATION_PATH = /^(?:\/u\/[^/]+)?(?:\/g\/[^/]+)?\/c\/([^/?#]+)/;

export type ChatGptTurnRole = 'user' | 'assistant' | 'unknown';

export interface ChatGptDomTurnContainer {
  /** Stable native identity; duplicate shells represent the same message. */
  id: string;
  /** The first shell establishes its position in the native retained list. */
  sequence: number;
  role: ChatGptTurnRole;
  container: HTMLElement;
}

export function findChatGptTurnFrame(container: HTMLElement): Element | null {
  return container.matches(TURN_FRAME_SELECTOR)
    ? container
    : container.querySelector(TURN_FRAME_SELECTOR);
}

export function resolveChatGptTurnRole(container: HTMLElement): ChatGptTurnRole {
  if (container.querySelector(CHATGPT_USER_MESSAGE_SELECTOR)) return 'user';
  if (
    container.querySelector(CHATGPT_ASSISTANT_MESSAGE_SELECTOR) ||
    container.querySelector(CHATGPT_IMAGEGEN_SELECTOR)
  ) {
    return 'assistant';
  }
  const role = findChatGptTurnFrame(container)?.getAttribute('data-turn');
  return role === 'user' || role === 'assistant' ? role : 'unknown';
}

/** Retained shells supply identity and order even while their message bodies are unmounted. */
export function chatgptCollectTurnContainers(
  root: ParentNode = document,
): ChatGptDomTurnContainer[] {
  const turnsById = new Map<string, ChatGptDomTurnContainer>();
  for (const container of root.querySelectorAll<HTMLElement>(CHATGPT_TURN_CONTAINER_SELECTOR)) {
    const id = container.getAttribute('data-turn-id-container')?.trim();
    if (!id || NON_TURN_CONTAINER_ID.test(id)) continue;
    const role = resolveChatGptTurnRole(container);
    const existing = turnsById.get(id);
    if (!existing) {
      turnsById.set(id, { id, sequence: turnsById.size, role, container });
    } else if (existing.role === 'unknown' && role !== 'unknown') {
      turnsById.set(id, { ...existing, role, container });
    }
  }
  return Array.from(turnsById.values());
}

export interface ChatGptTimelineTurn extends ChatGptDomTurnContainer {
  /** False for page-local WeakMap identities, which must never be persisted. */
  readonly persistent: boolean;
  readonly userElement: HTMLElement | null;
}

export interface ChatGptTimelineSnapshot {
  readonly status: 'ready' | 'pending';
  readonly root: HTMLElement | null;
  readonly turns: readonly ChatGptTimelineTurn[];
}

function hiddenFromCurrentView(element: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (
      current.hidden ||
      current.getAttribute('aria-hidden') === 'true' ||
      current.hasAttribute('inert') ||
      current.style.display === 'none' ||
      current.style.visibility === 'hidden'
    ) {
      return true;
    }
  }
  return false;
}

function userElementIn(container: HTMLElement): HTMLElement | null {
  if (container.matches(USER_BUBBLE_SELECTOR)) return container;
  const bubble = container.querySelector<HTMLElement>(USER_BUBBLE_SELECTOR);
  if (bubble) return bubble;
  return container.matches(CHATGPT_USER_MESSAGE_SELECTOR)
    ? container
    : container.querySelector<HTMLElement>(CHATGPT_USER_MESSAGE_SELECTOR);
}

function modernNativeId(container: HTMLElement): string | null {
  const turnKey = container.getAttribute('data-turn-key')?.trim();
  if (turnKey && NATIVE_UUID.test(turnKey)) return turnKey;
  const searchId = container.getAttribute('data-chatgpt-search-message-ids')?.trim();
  return searchId && NATIVE_UUID.test(searchId) ? searchId : null;
}

function modernTimelineRole(
  container: HTMLElement,
  nativeId: string,
  userElement: HTMLElement | null,
): ChatGptTurnRole {
  if (userElement) return 'user';
  if (container.getAttribute('data-turn') === 'assistant') return 'assistant';
  const assistant = container.matches(MODERN_ASSISTANT_SELECTOR)
    ? container
    : container.querySelector(MODERN_ASSISTANT_SELECTOR);
  if (assistant?.getAttribute('data-chatgpt-selection-message-id') === nativeId) return 'assistant';
  // A current turn-key wraps a whole Q&A round. An assistant with another
  // message UUID does not prove the unmounted user half changed its role.
  return resolveChatGptTurnRole(container) === 'user' ? 'user' : 'unknown';
}

/** One instance per navigator. No page-global cache or cross-window state is used. */
export class ChatGptTimelineProvider {
  private readonly temporaryIds = new WeakMap<HTMLElement, string>();
  private nextTemporaryId = 0;
  private sessionKey: string | null = null;
  private confirmedRoute: string | null = null;
  private confirmedIds = new Set<string>();
  private blockedIds = new Set<string>();
  private readonly creation = new NewConversationHandoff();

  constructor(private readonly doc: Document = document) {}

  /** Called only by scoped observers of the native composer, before submission mutates DOM. */
  recordNewConversationSubmission(draft: string): void {
    const root = this.currentRoot();
    if (this.formalRoute() || !root || this.collectTimelineTurns(root.root).length) return;
    this.creation.begin(this.doc.location.href, draft);
  }

  cancelNewConversationSubmission(): void {
    this.creation.cancel();
  }

  /** The same accepted temporary-chat DOM acquiring a formal route is not a new conversation. */
  promoteSession(nextKey: string): void {
    this.sessionKey = nextKey;
    this.confirmedRoute = this.formalRoute();
    this.blockedIds.clear();
  }

  snapshot(sessionKey: string): ChatGptTimelineSnapshot {
    if (this.sessionKey !== null && this.sessionKey !== sessionKey) {
      this.blockedIds = new Set([...this.blockedIds, ...this.confirmedIds]);
      this.confirmedIds.clear();
    }
    this.sessionKey = sessionKey;
    const current = this.currentRoot();
    if (!current) return { status: 'pending', root: null, turns: [] };
    const { root, routeConfirmed } = current;
    const turns = this.collectTimelineTurns(root);
    if (this.creation.accept(this.doc.location.href, turns)) this.promoteSession(sessionKey);
    const restoresConfirmedRoute =
      this.formalRoute() !== null &&
      this.formalRoute() === this.confirmedRoute &&
      turns.length > 0 &&
      turns.every((turn) => this.blockedIds.has(this.identityKey(turn)));
    if (
      (this.blockedIds.size > 0 && turns.length === 0) ||
      (!routeConfirmed &&
        !restoresConfirmedRoute &&
        turns.some((turn) => this.blockedIds.has(this.identityKey(turn))))
    ) {
      return { status: 'pending', root, turns: [] };
    }
    this.blockedIds.clear();
    this.confirmedIds = new Set(turns.map((turn) => this.identityKey(turn)));
    this.confirmedRoute = this.formalRoute();
    return { status: 'ready', root, turns };
  }

  private identityKey(turn: ChatGptTimelineTurn): string {
    return `${turn.persistent ? 'native' : 'page'}:${turn.id}`;
  }

  private formalRoute(): string | null {
    return CONVERSATION_PATH.test(this.doc.location.pathname)
      ? `${this.doc.location.origin}${this.doc.location.pathname}`
      : null;
  }

  private currentRoot(): { readonly root: HTMLElement; readonly routeConfirmed: boolean } | null {
    const mains = Array.from(this.doc.querySelectorAll<HTMLElement>('main')).filter(
      (main) => !hiddenFromCurrentView(main),
    );
    if (mains.length > 1) return null;
    const main = mains[0] ?? this.doc.body;
    if (!main || hiddenFromCurrentView(main)) return null;

    const roots = Array.from(
      main.querySelectorAll<HTMLElement>(CHATGPT_TURN_CONTAINER_SELECTOR),
    ).filter((container) => {
      const id = container.getAttribute('data-turn-id-container')?.trim();
      return !!id && NON_TURN_CONTAINER_ID.test(id) && !hiddenFromCurrentView(container);
    });
    const rootIds = new Set(roots.map((root) => root.getAttribute('data-turn-id-container')!));
    // Two root identities are a transition, not one conversation to merge.
    if (rootIds.size > 1) return null;
    const root = roots[0];
    const rootId = root?.getAttribute('data-turn-id-container') ?? '';
    if (rootId.startsWith('paginated-root:')) {
      const conversationId = this.doc.location.pathname.match(CONVERSATION_PATH)?.[1];
      if (!conversationId || rootId.slice('paginated-root:'.length) !== conversationId) return null;
    }
    // Some builds expose a root as a bookkeeping sibling rather than a wrapper.
    const wrapsTurns = !!root?.querySelector(
      `${CHATGPT_TURN_CONTAINER_SELECTOR}, ${TURN_KEY_SELECTOR}, ${USER_BUBBLE_SELECTOR}`,
    );
    return {
      root: root && wrapsTurns ? root : main,
      routeConfirmed: wrapsTurns && rootId.startsWith('paginated-root:'),
    };
  }

  private collectTimelineTurns(root: HTMLElement): ChatGptTimelineTurn[] {
    const turnsById = new Map<string, ChatGptTimelineTurn>();
    const positions = new Map<string, HTMLElement>();
    for (const container of root.querySelectorAll<HTMLElement>(CHATGPT_TURN_CONTAINER_SELECTOR)) {
      const id = container.getAttribute('data-turn-id-container')?.trim();
      if (!id || NON_TURN_CONTAINER_ID.test(id) || hiddenFromCurrentView(container)) continue;
      if (!positions.has(`native:${id}`)) positions.set(`native:${id}`, container);
      const existing = turnsById.get(id);
      const userElement = userElementIn(container);
      const role = userElement ? 'user' : resolveChatGptTurnRole(container);
      if (
        !existing ||
        (!existing.userElement && userElement) ||
        (existing.role === 'unknown' && role !== 'unknown')
      ) {
        turnsById.set(id, { id, sequence: 0, role, container, userElement, persistent: true });
      }
    }
    // Current ChatGPT uses UUID data-turn-key shells, with neither the older
    // data-turn-id-container nor data-message-author-role attributes.
    for (const candidate of root.querySelectorAll<HTMLElement>(
      `${TURN_KEY_SELECTOR}, ${SEARCH_MESSAGE_IDS_SELECTOR}`,
    )) {
      if (hiddenFromCurrentView(candidate)) continue;
      const nearestKey = candidate.closest<HTMLElement>(TURN_KEY_SELECTOR);
      const id = (nearestKey && modernNativeId(nearestKey)) || modernNativeId(candidate);
      if (!id) continue;
      const container = nearestKey && modernNativeId(nearestKey) ? nearestKey : candidate;
      const legacyShell = container.closest<HTMLElement>(CHATGPT_TURN_CONTAINER_SELECTOR);
      const legacyId = legacyShell?.getAttribute('data-turn-id-container')?.trim();
      if (legacyId && turnsById.has(legacyId)) continue;
      const nestedLegacy = container.querySelector<HTMLElement>(CHATGPT_TURN_CONTAINER_SELECTOR);
      const nestedId = nestedLegacy?.getAttribute('data-turn-id-container')?.trim();
      if (nestedId && turnsById.has(nestedId)) continue;
      const userElement = userElementIn(container);
      const role = modernTimelineRole(container, id, userElement);
      const existing = turnsById.get(id);
      if (
        !existing ||
        (!existing.userElement && userElement) ||
        (existing.role === 'unknown' && role !== 'unknown')
      ) {
        turnsById.set(id, { id, sequence: 0, role, container, persistent: true, userElement });
      }
      if (!positions.has(`native:${id}`)) positions.set(`native:${id}`, container);
    }
    const turns = Array.from(turnsById.values());
    const nativeIds = new Set(turnsById.keys());
    const coveredUsers = new Set(turns.map((turn) => turn.userElement));
    const coveredContainers = new Set(turns.map((turn) => turn.container));
    for (const candidate of root.querySelectorAll<HTMLElement>(
      `${USER_BUBBLE_SELECTOR}, ${CHATGPT_USER_MESSAGE_SELECTOR}`,
    )) {
      if (hiddenFromCurrentView(candidate)) continue;
      const userElement = userElementIn(candidate);
      if (!userElement || coveredUsers.has(userElement)) continue;
      const nativeContainer = userElement.closest<HTMLElement>(CHATGPT_TURN_CONTAINER_SELECTOR);
      const nativeId = nativeContainer?.getAttribute('data-turn-id-container')?.trim();
      if (nativeId && nativeIds.has(nativeId)) continue;
      const modernContainer = userElement.closest<HTMLElement>(TURN_KEY_SELECTOR);
      const modernId =
        (modernContainer && modernNativeId(modernContainer)) || modernNativeId(userElement);
      if (modernId && nativeIds.has(modernId)) continue;
      const container =
        userElement.closest<HTMLElement>('[data-turn], [data-turn-key]') ?? userElement;
      if (coveredContainers.has(container)) continue;
      let id = this.temporaryIds.get(container);
      if (!id) {
        id = `page-${++this.nextTemporaryId}`;
        this.temporaryIds.set(container, id);
      }
      const turn: ChatGptTimelineTurn = {
        id,
        sequence: 0,
        role: 'user',
        container,
        persistent: false,
        userElement,
      };
      turns.push(turn);
      positions.set(`page:${id}`, container);
      coveredUsers.add(userElement);
      coveredContainers.add(container);
    }
    turns.sort((left, right) => {
      const leftNode = positions.get(this.identityKey(left)) ?? left.container;
      const rightNode = positions.get(this.identityKey(right)) ?? right.container;
      if (leftNode === rightNode) return 0;
      return leftNode.compareDocumentPosition(rightNode) & Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1;
    });
    return turns.map((turn, sequence) => ({ ...turn, sequence }));
  }
}
