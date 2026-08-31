const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeTimeRanges, normalizeTrimRanges } = require('./time-ranges.cjs');

test('normalizeTimeRanges orders and merges overlapping kept sections', () => {
    assert.deepEqual(
        normalizeTimeRanges([
            { startTime: 8, endTime: 10 },
            { startTime: 1, endTime: 4 },
            { startTime: 3.5, endTime: 6 }
        ]),
        [
            { startTime: 1, endTime: 6 },
            { startTime: 8, endTime: 10 }
        ]
    );
});

test('normalizeTimeRanges rejects invalid ranges and clamps to bounds', () => {
    assert.deepEqual(
        normalizeTimeRanges([
            { startTime: -2, endTime: 2 },
            { startTime: 3, endTime: 3 },
            { startTime: 'nope', endTime: 5 },
            { startTime: 8, endTime: 15 }
        ], { minimum: 0, maximum: 10 }),
        [
            { startTime: 0, endTime: 2 },
            { startTime: 8, endTime: 10 }
        ]
    );
});

test('normalizeTrimRanges supports legacy start/end callers', () => {
    assert.deepEqual(normalizeTrimRanges(undefined, 2, 7), [{ startTime: 2, endTime: 7 }]);
});
