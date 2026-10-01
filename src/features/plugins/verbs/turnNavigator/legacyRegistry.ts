import { hashString } from '@/core/utils/hash';

import type { Marker } from './markerTypes';

/** Retain Claude/DeepSeek sliding windows without assuming missing turns were deleted. */
export function mergeLegacyTurns(
  known: Marker[],
  turns: HTMLElement[],
  extractText: (element: HTMLElement) => string,
  computeCenter: (element: HTMLElement) => number,
): Marker[] {
  const mounted = turns.map((element) => {
    const summary = extractText(element);
    return { element, summary, hash: hashString(summary) };
  });
  if (!mounted.length) return known;

  const matchedKnownIndex = new Array<number>(mounted.length).fill(-1);
  let searchFrom = 0;
  for (let i = 0; i < mounted.length; i++) {
    for (let j = searchFrom; j < known.length; j++) {
      if (known[j].hash === mounted[i].hash) {
        matchedKnownIndex[i] = j;
        searchFrom = j + 1;
        break;
      }
    }
  }

  const usedIds = new Set(known.map((marker) => marker.id));
  const createMarker = (entry: (typeof mounted)[number]): Marker => {
    const id = claimTurnId(entry.hash, usedIds);
    entry.element.dataset.gvTurnId = id;
    return {
      id,
      hash: entry.hash,
      summary: entry.summary,
      starred: false,
      element: entry.element,
      center: computeCenter(entry.element),
      dotElement: null,
    };
  };

  const firstMatch = matchedKnownIndex.findIndex((index) => index >= 0);
  if (firstMatch === -1) {
    // Jumped into an unexplored region: place the whole block by its
    // vertical position relative to the accumulated turns.
    const fresh = mounted.map(createMarker);
    const insertAt = known.findIndex((marker) => marker.center > fresh[0].center);
    return insertAt === -1
      ? [...known, ...fresh]
      : [...known.slice(0, insertAt), ...fresh, ...known.slice(insertAt)];
  }

  const beforeFirstAnchor: Marker[] = [];
  const afterKnownIndex = new Map<number, Marker[]>();
  // Fresh centre minus remembered centre per anchor: how far Claude's
  // re-measuring has shifted this region since the neighbours were seen.
  const anchorDrift = new Map<number, number>();
  let lastAnchor = -1;
  for (let i = 0; i < mounted.length; i++) {
    const knownIndex = matchedKnownIndex[i];
    if (knownIndex >= 0) {
      const survivor = known[knownIndex];
      anchorDrift.set(knownIndex, computeCenter(mounted[i].element) - survivor.center);
      survivor.element = mounted[i].element;
      survivor.summary = mounted[i].summary;
      mounted[i].element.dataset.gvTurnId = survivor.id;
      lastAnchor = knownIndex;
      continue;
    }
    const marker = createMarker(mounted[i]);
    if (lastAnchor === -1) {
      beforeFirstAnchor.push(marker);
    } else {
      const bucket = afterKnownIndex.get(lastAnchor);
      if (bucket) bucket.push(marker);
      else afterKnownIndex.set(lastAnchor, [marker]);
    }
  }

  // Anchors fix the order of the turns they match; a block of new turns is
  // then filed by scroll position among the known turns between its two
  // bounding anchors. "Right next to the anchor" is not enough: Claude keeps
  // the latest turn mounted while the reader sits at the top, and that lone
  // tail anchor would drag the conversation's opening turns behind the
  // bottom window. Known centres are compared after the nearest anchor's
  // drift so re-measured content does not skew the comparison.
  const anchors = matchedKnownIndex.filter((index) => index >= 0);
  const insertBefore = new Map<number, Marker[]>();
  // A known turn between two anchors is assumed to have drifted like the
  // anchor nearer to it; anchors on different sides of a re-measured region
  // can carry very different drifts.
  const driftAt = (index: number, prev: number | undefined, next: number | undefined): number => {
    const prevDrift = prev === undefined ? undefined : anchorDrift.get(prev);
    const nextDrift = next === undefined ? undefined : anchorDrift.get(next);
    if (prevDrift === undefined) return nextDrift ?? 0;
    if (nextDrift === undefined) return prevDrift;
    return index - prev! <= next! - index ? prevDrift : nextDrift;
  };
  const file = (block: Marker[], prev: number | undefined, next: number | undefined): void => {
    if (!block.length) return;
    const lo = prev === undefined ? 0 : prev + 1;
    const hi = next ?? known.length;
    let at = hi;
    for (let index = lo; index < hi; index++) {
      if (known[index].center + driftAt(index, prev, next) > block[0].center) {
        at = index;
        break;
      }
    }
    const bucket = insertBefore.get(at);
    if (bucket) bucket.push(...block);
    else insertBefore.set(at, block);
  };
  file(beforeFirstAnchor, undefined, anchors[0]);
  anchors.forEach((anchor, rank) => {
    const block = afterKnownIndex.get(anchor);
    if (block) file(block, anchor, anchors[rank + 1]);
  });

  const result: Marker[] = [];
  known.forEach((marker, index) => {
    const block = insertBefore.get(index);
    if (block) result.push(...block);
    result.push(marker);
  });
  const tail = insertBefore.get(known.length);
  if (tail) result.push(...tail);
  return result;
}

function claimTurnId(hash: string, usedIds: Set<string>): string {
  const base = `c-${hash}`;
  let id = base;
  for (let n = 2; usedIds.has(id); n++) id = `${base}~${n}`;
  usedIds.add(id);
  return id;
}
