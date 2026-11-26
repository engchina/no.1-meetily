export type SpeakerModel = 'local' | 'community-1';
export type SpeakerTurn = [start: number, end: number, speaker: number];
export interface SpeakerTimeline {
  model: SpeakerModel;
  turns: SpeakerTurn[];
  names: Record<number, string>;
}

const preferenceKey = 'meetingSpeakerModel';
export function selectedSpeakerModel(): SpeakerModel | null {
  if (typeof window === 'undefined') return null;
  const model = localStorage.getItem(preferenceKey);
  return model === 'local' || model === 'community-1' ? model : null;
}
export function saveSpeakerModel(model: SpeakerModel | null) {
  if (model) localStorage.setItem(preferenceKey, model);
  else localStorage.removeItem(preferenceKey);
}

// Index the end times as well as the sorted starts so overlapping turns are included.
export function speakerLookup(turns: SpeakerTurn[]) {
  let maxEnd = 0;
  const ends = turns.map(([,end]) => maxEnd = Math.max(maxEnd, end));
  return (start: number, end?: number) => {
    const stop = end ?? start;
    if (stop < start) return undefined;
    let low = 0, high = ends.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (ends[mid] <= start) low = mid + 1;
      else high = mid;
    }
    const overlaps = new Map<number, number>();
    for (let i = low; i < turns.length && turns[i][0] <= stop; i++) {
      const [a,b,id] = turns[i];
      if (stop === start && a <= start && start < b) return id;
      const overlap = Math.min(b, stop) - Math.max(a, start);
      if (overlap > 0) overlaps.set(id, (overlaps.get(id) ?? 0) + overlap);
    }
    let best: number | undefined;
    let longest = 0;
    for (const [id, duration] of overlaps) {
      if (duration > longest) { longest = duration; best = id; }
    }
    return best;
  };
}
