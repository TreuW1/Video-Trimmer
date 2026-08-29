const assert = require('node:assert/strict');
const test = require('node:test');

const {
    checkForUpdate,
    compareVersions,
    parseVersion
} = require('../update-check.cjs');

test('accepts standard and first-release version prefixes', () => {
    assert.ok(parseVersion('1.2.3'));
    assert.ok(parseVersion('v1.2.3'));
    assert.ok(parseVersion('v.1.2.3'));
    assert.equal(parseVersion('.1.2.3'), null);
});

test('compares a legacy-prefixed release tag as semantic versioning', () => {
    assert.equal(compareVersions('v.1.0.1', '1.0.0'), 1);
    assert.equal(compareVersions('v.1.0.0', '1.0.0'), 0);
});

test('normalizes the first public release tag in update results', async () => {
    const fetchImpl = async () => ({
        ok: true,
        json: async () => ({
            tag_name: 'v.1.0.0',
            html_url: 'https://github.com/TreuW1/Video-Trimmer/releases/tag/v.1.0.0',
            name: 'Release 1.0.0',
            published_at: '2026-08-11T13:16:49Z'
        })
    });

    const result = await checkForUpdate('1.0.0', fetchImpl);

    assert.equal(result.latestVersion, '1.0.0');
    assert.equal(result.updateAvailable, false);
});
