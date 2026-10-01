import { hashString } from '@/core/utils/hash';

import { MAX_REGEX_INPUT_LENGTH } from '../../sites/safeRegex';

export function buildConversationId(
  config: { readonly siteId: string; readonly conversationIdPattern?: string },
  input: string = location.href,
): string {
  try {
    const url = new URL(input, location.origin);
    if (config.conversationIdPattern) {
      // The pattern policy (sites/safeRegex.ts) forbids the constructs that
      // backtrack catastrophically; a bounded subject caps the rest.
      const subject = url.pathname.slice(0, MAX_REGEX_INPUT_LENGTH);
      const match = new RegExp(config.conversationIdPattern).exec(subject);
      if (match?.[1]) return `${config.siteId}:conv:${match[1]}`;
    }
    return `${config.siteId}:${hashString(`${url.origin}${url.pathname}`)}`;
  } catch {
    return `${config.siteId}:${hashString(String(input || ''))}`;
  }
}

export function buildTurnId(text: string): string {
  return `c-${hashString(text)}`;
}

export function buildClaudeConversationId(input = location.href): string {
  try {
    const url = new URL(input, location.origin);
    const chatId = url.pathname.match(/^\/chat\/([^/?#]+)/)?.[1];
    return chatId
      ? `claude:conv:${chatId}`
      : `claude:${hashString(`${url.origin}${url.pathname}`)}`;
  } catch {
    return `claude:${hashString(String(input || ''))}`;
  }
}

export function buildClaudeTurnId(text: string): string {
  return `c-${hashString(text)}`;
}

/**
 * Content hash shared by every historical turn-id format:
 * legacy `c-<mountIndex>-<hash>`, current `c-<hash>` and `c-<hash>~<n>`.
 */
export function extractClaudeTurnHash(turnId: string): string {
  const base = turnId.split('~')[0];
  const segments = base.split('-');
  return segments[segments.length - 1] || base;
}

/** Claude renders artifacts in a sandboxed claudeusercontent.com iframe. */
export function hasOpenClaudeArtifact(doc: Document = document): boolean {
  return !!doc.querySelector('iframe[src*="claudeusercontent.com"]');
}
