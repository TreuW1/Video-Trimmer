'use strict';

const MIN_TIME_RANGE_SECONDS = 0.001;

/**
 * Validates, clamps, orders, and coalesces source-time ranges. Keeping this at
 * the API boundary prevents overlapping sections from duplicating output.
 */
function normalizeTimeRanges(ranges, options = {}) {
    if (!Array.isArray(ranges)) return [];

    const minimum = Number.isFinite(options.minimum) ? options.minimum : 0;
    const maximum = Number.isFinite(options.maximum) ? options.maximum : Number.POSITIVE_INFINITY;
    const minDuration = Number.isFinite(options.minDuration)
        ? options.minDuration
        : MIN_TIME_RANGE_SECONDS;

    const normalized = ranges
        .map((range) => ({
            startTime: Math.max(minimum, Number(range?.startTime)),
            endTime: Math.min(maximum, Number(range?.endTime))
        }))
        .filter((range) =>
            Number.isFinite(range.startTime) &&
            Number.isFinite(range.endTime) &&
            range.endTime - range.startTime >= minDuration
        )
        .sort((left, right) => left.startTime - right.startTime);

    return normalized.reduce((merged, range) => {
        const previous = merged[merged.length - 1];
        if (previous && range.startTime <= previous.endTime + MIN_TIME_RANGE_SECONDS) {
            previous.endTime = Math.max(previous.endTime, range.endTime);
        } else {
            merged.push({ ...range });
        }
        return merged;
    }, []);
}

function normalizeTrimRanges(ranges, fallbackStart, fallbackEnd) {
    const requestedRanges = Array.isArray(ranges) && ranges.length > 0
        ? ranges
        : [{ startTime: fallbackStart, endTime: fallbackEnd }];
    return normalizeTimeRanges(requestedRanges);
}

module.exports = {
    MIN_TIME_RANGE_SECONDS,
    normalizeTimeRanges,
    normalizeTrimRanges
};
