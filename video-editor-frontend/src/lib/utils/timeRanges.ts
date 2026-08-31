import type { TrimRange, VideoTrack } from '$lib/types/editor';
import { parseTime } from '$lib/utils/time';

export const MIN_TRIM_RANGE_SECONDS = 0.05;

export function normalizeTrimRanges(
  ranges: unknown,
  duration = Number.POSITIVE_INFINITY
): TrimRange[] {
  if (!Array.isArray(ranges)) return [];

  const maximum = Number.isFinite(duration) && duration >= 0
    ? duration
    : Number.POSITIVE_INFINITY;
  const sorted = ranges
    .map((range) => ({
      startTime: Math.max(0, Number((range as Partial<TrimRange>)?.startTime)),
      endTime: Math.min(maximum, Number((range as Partial<TrimRange>)?.endTime))
    }))
    .filter(
      (range) =>
        Number.isFinite(range.startTime) &&
        Number.isFinite(range.endTime) &&
        range.endTime - range.startTime >= MIN_TRIM_RANGE_SECONDS
    )
    .sort((left, right) => left.startTime - right.startTime);

  return sorted.reduce<TrimRange[]>((merged, range) => {
    const previous = merged[merged.length - 1];
    if (previous && range.startTime <= previous.endTime + 0.001) {
      previous.endTime = Math.max(previous.endTime, range.endTime);
    } else {
      merged.push({ ...range });
    }
    return merged;
  }, []);
}

/** Reads the new range model while remaining compatible with legacy start/end state. */
export function getTrackTrimRanges(track: VideoTrack): TrimRange[] {
  const normalized = normalizeTrimRanges(track.trimRanges, track.duration || Number.POSITIVE_INFINITY);
  if (normalized.length > 0) return normalized;

  const startTime = parseTime(track.startTime);
  const endTime = parseTime(track.endTime);
  return endTime - startTime >= MIN_TRIM_RANGE_SECONDS
    ? [{ startTime, endTime }]
    : [];
}

export function sumTrimRangeDurations(ranges: TrimRange[]): number {
  return ranges.reduce((total, range) => total + Math.max(0, range.endTime - range.startTime), 0);
}

/** Returns the section containing the playhead, or the nearest section across a gap. */
export function findClosestTrimRangeIndex(ranges: TrimRange[], playheadTime: number): number {
  if (ranges.length === 0) return -1;

  const time = Number.isFinite(playheadTime) ? playheadTime : 0;
  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index];
    const distance = time < range.startTime
      ? range.startTime - time
      : time > range.endTime
        ? time - range.endTime
        : 0;
    if (distance < closestDistance) {
      closestIndex = index;
      closestDistance = distance;
    }
  }

  return closestIndex;
}

/** Finds a useful empty section at or after the playhead for the Add section action. */
export function findAvailableTrimRange(
  ranges: TrimRange[],
  playheadTime: number,
  duration: number,
  preferredLengthSeconds = 1
): TrimRange | null {
  if (!Number.isFinite(duration) || duration < MIN_TRIM_RANGE_SECONDS) return null;

  const normalized = normalizeTrimRanges(ranges, duration);
  const gaps: TrimRange[] = [];
  let cursor = 0;
  for (const range of normalized) {
    if (range.startTime - cursor >= MIN_TRIM_RANGE_SECONDS) {
      gaps.push({ startTime: cursor, endTime: range.startTime });
    }
    cursor = Math.max(cursor, range.endTime);
  }
  if (duration - cursor >= MIN_TRIM_RANGE_SECONDS) {
    gaps.push({ startTime: cursor, endTime: duration });
  }

  const clampedPlayhead = Math.max(0, Math.min(duration, playheadTime));
  const usableGaps = gaps
    .map((gap) => ({
      startTime: gap.startTime + (gap.startTime > 0 ? MIN_TRIM_RANGE_SECONDS : 0),
      endTime: gap.endTime - (gap.endTime < duration ? MIN_TRIM_RANGE_SECONDS : 0)
    }))
    .filter((gap) => gap.endTime - gap.startTime >= MIN_TRIM_RANGE_SECONDS);
  const gap = usableGaps.find((candidate) => candidate.endTime > clampedPlayhead + 0.001)
    ?? usableGaps[0];
  if (!gap) return null;

  const startTime = Math.max(gap.startTime, Math.min(clampedPlayhead, gap.endTime - MIN_TRIM_RANGE_SECONDS));
  return {
    startTime,
    endTime: Math.min(gap.endTime, startTime + Math.max(MIN_TRIM_RANGE_SECONDS, preferredLengthSeconds))
  };
}
