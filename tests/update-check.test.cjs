const test = require('node:test');
const assert = require('node:assert/strict');
const {
    GITHUB_LATEST_RELEASE_URL,
    checkForUpdate,
    compareVersions,
    parseVersion
} = require('../update-check.cjs');

test('parses release tags and semantic prereleases', () => {
    assert.deepEqual(parseVersion('v1.2.3'), { numbers: [1, 2, 3], prerelease: [] });
    assert.deepEqual(parseVersion('1.2.3-beta.2'), {
        numbers: [1, 2, 3],
        prerelease: ['beta', '2']
    });
    assert.equal(parseVersion('release-1.2'), null);
});

test('compares versions without treating an older GitHub release as an update', () => {
    assert.equal(compareVersions('1.1.0', '1.0.9'), 1);
    assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
    assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.1'), 1);
    assert.equal(compareVersions('1.0.0', '1.0.0-beta.2'), 1);
    assert.equal(compareVersions('1.9.0', '2.0.0'), -1);
});

test('maps the latest GitHub release to an available update', async () => {
    let requestedUrl;
    const result = await checkForUpdate('1.0.0', async (url) => {
        requestedUrl = url;
        return {
            ok: true,
            async json() {
                return {
                    tag_name: 'v1.2.0',
                    name: 'Video Trimmer 1.2.0',
                    html_url: 'https://github.com/TreuW1/Video-Trimmer/releases/tag/v1.2.0',
                    published_at: '2026-08-10T12:00:00Z'
                };
            }
        };
    });

    assert.equal(requestedUrl, GITHUB_LATEST_RELEASE_URL);
    assert.equal(result.updateAvailable, true);
    assert.equal(result.latestVersion, '1.2.0');
    assert.equal(result.currentVersion, '1.0.0');
});

test('reports a matching release as current', async () => {
    const result = await checkForUpdate('1.0.0', async () => ({
        ok: true,
        async json() {
            return {
                tag_name: '1.0.0',
                html_url: 'https://github.com/TreuW1/Video-Trimmer/releases/tag/1.0.0'
            };
        }
    }));

    assert.equal(result.updateAvailable, false);
    assert.equal(result.releaseName, 'Version 1.0.0');
});

test('rejects failed GitHub responses and untrusted release links', async () => {
    await assert.rejects(checkForUpdate('1.0.0', async () => ({ ok: false, status: 404 })), {
        message: 'No public release was found for this app',
        code: 'NO_PUBLIC_RELEASE'
    });
    await assert.rejects(checkForUpdate('1.0.0', async () => ({ ok: false, status: 503 })), {
        message: 'GitHub returned HTTP 503',
        code: 'GITHUB_ERROR'
    });
    await assert.rejects(
        checkForUpdate('1.0.0', async () => ({
            ok: true,
            async json() {
                return {
                    tag_name: '1.1.0',
                    html_url: 'https://example.com/not-a-release'
                };
            }
        })),
        /invalid download page/
    );
});
