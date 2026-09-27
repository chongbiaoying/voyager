# ChatGPT · Timeline

Adds a conversation timeline using Voyager's existing `turnNavigator` primitive,
with message navigation, starred messages, search and an optional compact view.
The plugin contains no executable code or site-specific styles. User-message
selection, conversation identity and theme come from the existing ChatGPT adapter.

- Requires plugin engine 1.4.0 or newer.
- Ships disabled; enable it in the Voyager popup on ChatGPT.
- Matches `chatgpt.com` and the legacy `chat.openai.com` host.
- Standard `/c/<id>` conversations use `chatgpt:conv:<id>` for starred messages.
  Other paths use the shared engine's path-based fallback identity.
- Reuses the shared timeline UI and automatic scroll-container detection.

## MVP limits and verification

The navigator indexes user messages mounted in the DOM and retains discovered
markers while scrolling through virtualized content. It does not fetch unseen
history. Reloading rebuilds the index from the messages ChatGPT mounts again.
Conversation changes are detected during DOM-triggered refreshes; route-only
transitions, repeated prompts, edited messages and branch changes need live checks.

Automated fixtures cover user-only nodes, a 60-message list, nested scrolling,
message insertion, DOM replacement during conversation switching, and teardown
and restart. These fixtures do not prove compatibility with ChatGPT's live DOM.
Before release, verify the home page, a normal chat, a conversation over 50 turns,
new messages, conversation switching and reload in both light and dark themes.
