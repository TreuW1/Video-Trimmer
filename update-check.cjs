const GITHUB_LATEST_RELEASE_URL =
    'https://api.github.com/repos/TreuW1/Video-Trimmer/releases/latest';

function parseVersion(version) {
    if (typeof version !== 'string') return null;

    // Accept the conventional "v1.2.3" prefix and the legacy "v.1.2.3"
    // prefix used by the first public release.
    const match = version.trim().match(/^(?:v\.?)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i);
    if (!match) return null;

    return {
        numbers: match.slice(1, 4).map(Number),
        prerelease: match[4] ? match[4].split('.') : []
    };
}

function comparePrereleaseIdentifiers(left, right) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const leftPart = left[index];
        const rightPart = right[index];

        if (leftPart === undefined) return -1;
        if (rightPart === undefined) return 1;
        if (leftPart === rightPart) continue;

        const leftIsNumeric = /^\d+$/.test(leftPart);
        const rightIsNumeric = /^\d+$/.test(rightPart);
        if (leftIsNumeric && rightIsNumeric) return Number(leftPart) > Number(rightPart) ? 1 : -1;
        if (leftIsNumeric !== rightIsNumeric) return leftIsNumeric ? -1 : 1;
        return leftPart > rightPart ? 1 : -1;
    }
    return 0;
}

function compareVersions(leftVersion, rightVersion) {
    const left = parseVersion(leftVersion);
    const right = parseVersion(rightVersion);
    if (!left || !right) throw new Error('Invalid semantic version');

    for (let index = 0; index < 3; index += 1) {
        if (left.numbers[index] !== right.numbers[index]) {
            return left.numbers[index] > right.numbers[index] ? 1 : -1;
        }
    }

    if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
    if (left.prerelease.length === 0) return 1;
    if (right.prerelease.length === 0) return -1;
    return comparePrereleaseIdentifiers(left.prerelease, right.prerelease);
}

async function checkForUpdate(currentVersion, fetchImpl = globalThis.fetch) {
    if (!parseVersion(currentVersion)) throw new Error('The installed app version is invalid');
    if (typeof fetchImpl !== 'function') throw new Error('This Node.js runtime does not support update checks');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await fetchImpl(GITHUB_LATEST_RELEASE_URL, {
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': `VideoTrimmer/${currentVersion}`,
                'X-GitHub-Api-Version': '2022-11-28'
            },
            redirect: 'follow',
            signal: controller.signal
        });

        if (!response.ok) {
            const error = new Error(
                response.status === 404
                    ? 'No public release was found for this app'
                    : `GitHub returned HTTP ${response.status}`
            );
            error.code = response.status === 404 ? 'NO_PUBLIC_RELEASE' : 'GITHUB_ERROR';
            throw error;
        }

        const release = await response.json();
        const latestVersion = typeof release.tag_name === 'string'
            ? release.tag_name.trim().replace(/^v\.?/i, '')
            : '';
        if (!parseVersion(latestVersion)) throw new Error('The latest release has an invalid version tag');

        const releaseUrl = release.html_url;
        const expectedUrlPrefix = 'https://github.com/TreuW1/Video-Trimmer/releases/';
        if (typeof releaseUrl !== 'string' || !releaseUrl.startsWith(expectedUrlPrefix)) {
            throw new Error('The latest release has an invalid download page');
        }

        return {
            currentVersion,
            latestVersion,
            updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
            releaseUrl,
            releaseName: typeof release.name === 'string' && release.name.trim()
                ? release.name.trim()
                : `Version ${latestVersion}`,
            publishedAt: typeof release.published_at === 'string' ? release.published_at : null
        };
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = {
    GITHUB_LATEST_RELEASE_URL,
    checkForUpdate,
    compareVersions,
    parseVersion
};
