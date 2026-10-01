/** One document's runtime identity, separate from the persisted star key. */
export class ConversationSession {
  private route = '';
  private generation = 0;
  private key = '';
  private persistentId: string | null = null;

  sync(conversationId: string, href: string, temporaryAware: boolean): boolean {
    const url = new URL(href);
    const route = `${conversationId}|${url.origin}${url.pathname}|${url.searchParams.get('temporary-chat') ?? ''}`;
    if (route === this.route) return false;
    this.route = route;
    this.persistentId =
      temporaryAware && !conversationId.startsWith('chatgpt:conv:') ? null : conversationId;
    this.restart();
    return true;
  }

  restart(): void {
    this.key = `${this.route}|${++this.generation}`;
  }

  get token(): string {
    return this.key;
  }
  get storageId(): string | null {
    return this.persistentId;
  }
  isCurrent(token: string): boolean {
    return token === this.key;
  }
}
