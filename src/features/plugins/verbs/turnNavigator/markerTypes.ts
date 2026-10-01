export type Dot = HTMLButtonElement & {
  dataset: DOMStringMap & { targetTurnId?: string; markerIndex?: string };
};

export interface Marker {
  id: string;
  hash: string;
  summary: string;
  starred: boolean;
  starredAt?: number;
  element: HTMLElement;
  center: number;
  dotElement: Dot | null;
  /** ChatGPT's shell remains connected when its user bubble is virtualized out. */
  shell?: HTMLElement;
  mountedElement?: HTMLElement | null;
  persistent?: boolean;
}
