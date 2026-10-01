import type { ChatGptDomTurnContainer } from '@/features/plugins/sites/adapters/chatgptTurns';

export type { ChatGptTurnRole } from '@/features/plugins/sites/adapters/chatgptTurns';

export interface ChatGptTurnContainer extends ChatGptDomTurnContainer {
  /**
   * ChatGPT 渲染了该 turn 的外框，但其中没有任何消息（例如只产出了已不再展示的文件的回复）。
   * 仅由 materialize 在内容稳定为空后设置。
   */
  empty?: boolean;
}

export interface ExportSelectionOptions {
  /** Cancels virtual-list scrolling when the plugin is disabled or the user cancels. */
  readonly signal?: AbortSignal;

  /** Route captured before collection; changing conversations invalidates the export. */
  readonly expectedUrl?: string;
}
