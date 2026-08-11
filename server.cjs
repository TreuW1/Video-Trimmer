const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const cors = require('cors');
const { spawn } = require('child_process');
const compression = require('compression');
const builtInCompressionPresets = require('./compression-presets.json');
const { checkForUpdate } = require('./update-check.cjs');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '127.0.0.1';
const API_TOKEN = process.env.VIDEO_TRIMMER_AUTH_TOKEN || crypto.randomBytes(32).toString('hex');
const ALLOWED_ORIGINS = new Set(
    (process.env.VIDEO_TRIMMER_ALLOWED_ORIGINS ||
        'http://localhost:5173,http://127.0.0.1:5173,http://tauri.localhost,https://tauri.localhost,tauri://localhost')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
);

const uploadLimits = require('./upload-limits.json');
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_UPLOAD_BYTES = Number.isSafeInteger(uploadLimits.maxUploadBytes) && uploadLimits.maxUploadBytes > 0
    ? Math.min(uploadLimits.maxUploadBytes, DEFAULT_MAX_UPLOAD_BYTES)
    : DEFAULT_MAX_UPLOAD_BYTES;

// Browser access is limited to the packaged app and the local Vite development server.
app.use(cors({
    origin(origin, callback) {
        if (!origin || ALLOWED_ORIGINS.has(origin)) return callback(null, true);
        const error = new Error('Origin is not allowed');
        error.statusCode = 403;
        return callback(error);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-Video-Trimmer-Token'],
    maxAge: 600
}));

function tokenMatches(candidate) {
    if (typeof candidate !== 'string') return false;
    const supplied = Buffer.from(candidate);
    const expected = Buffer.from(API_TOKEN);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

app.use((req, res, next) => {
    if (tokenMatches(req.get('X-Video-Trimmer-Token'))) return next();
    res.set('Cache-Control', 'no-store');
    return res.status(401).json({ error: 'Unauthorized' });
});

// Enable compression for all responses
app.use(compression({
    level: 6,
    threshold: 0,
    filter: (req, res) => {
        if (req.headers['x-no-compression']) {
            return false;
        }
        return compression.filter(req, res);
    }
}));

app.use(express.json({ limit: '1mb' }));

// Create directories for uploads and outputs
const DATA_DIR = path.resolve(process.env.VIDEO_TRIMMER_DATA_DIR || __dirname);
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const OUTPUT_DIR = path.join(DATA_DIR, 'outputs');
const TEMP_DIR = path.join(DATA_DIR, 'temp');
const CUSTOM_COMPRESSION_PRESETS_PATH = path.join(DATA_DIR, 'custom-compression-presets.json');
const SCOPES_FILE = process.env.VIDEO_TRIMMER_SCOPES_FILE
    ? path.resolve(process.env.VIDEO_TRIMMER_SCOPES_FILE)
    : null;
const APP_VERSION = (() => {
    try {
        return fsSync.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim();
    } catch {
        return process.env.VIDEO_TRIMMER_VERSION || '0.0.0';
    }
})();

// Track uploaded videos
const uploadedVideos = new Map();

async function resolveOutputDirectory(outputDirectory) {
    if (typeof outputDirectory !== 'string' || outputDirectory.trim() === '') {
        return OUTPUT_DIR;
    }

    const resolved = await fs.realpath(path.resolve(outputDirectory.trim()));
    const scopes = await readFilesystemScopes();
    if (!scopes.outputDirectories.some((directory) => pathIsWithin(resolved, directory))) {
        const error = new Error('Output folder has not been authorized with the native folder picker');
        error.statusCode = 403;
        throw error;
    }
    return resolved;
}

function pathIsWithin(candidate, directory) {
    const relative = path.relative(directory, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function readFilesystemScopes() {
    if (!SCOPES_FILE) return { readFiles: [], libraryDirectories: [], outputDirectories: [] };
    try {
        const parsed = JSON.parse(await fs.readFile(SCOPES_FILE, 'utf8'));
        return {
            readFiles: Array.isArray(parsed.readFiles) ? parsed.readFiles.map((value) => path.resolve(value)) : [],
            libraryDirectories: Array.isArray(parsed.libraryDirectories) ? parsed.libraryDirectories.map((value) => path.resolve(value)) : [],
            outputDirectories: Array.isArray(parsed.outputDirectories) ? parsed.outputDirectories.map((value) => path.resolve(value)) : []
        };
    } catch (error) {
        if (error.code !== 'ENOENT') console.warn(`Could not read filesystem scopes: ${error.message}`);
        return { readFiles: [], libraryDirectories: [], outputDirectories: [] };
    }
}

async function isAuthorizedInputPath(candidate) {
    const scopes = await readFilesystemScopes();
    return scopes.readFiles.includes(candidate) ||
        scopes.libraryDirectories.some((directory) => pathIsWithin(candidate, directory));
}

function probeMedia(inputPath) {
    return new Promise((resolve, reject) => {
        const child = spawn('ffprobe', [
            '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inputPath
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-12000); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) return reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`));
            try {
                const metadata = JSON.parse(stdout);
                if (metadata.format) {
                    metadata.format.duration = Number(metadata.format.duration);
                    metadata.format.size = Number(metadata.format.size);
                }
                resolve(metadata);
            } catch (error) {
                reject(new Error(`Could not parse ffprobe output: ${error.message}`));
            }
        });
    });
}

function runDirectFfmpeg(args, { duration = null, progressCallback = null, job = null, label = 'FFmpeg' } = {}) {
    return new Promise((resolve, reject) => {
        const fullArgs = ['-hide_banner', '-y', '-progress', 'pipe:2', '-nostats', ...args];
        console.log(`${label} command: ffmpeg ${fullArgs.join(' ')}`);
        const child = spawn('ffmpeg', fullArgs, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        if (job) job.ffmpegProcess = child;
        let stderrOutput = '';
        let buffered = '';
        child.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            stderrOutput = `${stderrOutput}${text}`.slice(-12000);
            buffered += text;
            const lines = buffered.split(/\r?\n/);
            buffered = lines.pop() || '';
            if (!progressCallback || !duration) return;
            for (const line of lines) {
                const match = /^(?:out_time|time)=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(line.trim());
                if (!match) continue;
                const seconds = parseFfmpegTimemark(match[1]);
                if (Number.isFinite(seconds)) {
                    progressCallback(formatProgressPercent((seconds / duration) * 100));
                }
            }
        });
        child.on('error', (error) => {
            if (job) job.ffmpegProcess = null;
            reject(error);
        });
        child.on('close', (code) => {
            if (job) job.ffmpegProcess = null;
            if (code === 0) return resolve();
            reject(new Error(stderrOutput.trim() || `${label} exited with code ${code}`));
        });
    });
}

function buildEncodingArgs(input, output, {
    startTime = null,
    duration = null,
    inputOptions = [],
    videoCodec,
    audioCodec,
    outputOptions = []
}) {
    const args = [...inputOptions];
    if (startTime != null) args.push('-ss', String(startTime));
    if (duration != null) args.push('-t', String(duration));
    args.push('-i', input, '-c:v', videoCodec, '-c:a', audioCodec, ...outputOptions, '-f', 'mp4', output);
    return args;
}

function normalizeOutputFilename(outputFilename, compressionMode) {
    if (typeof outputFilename !== 'string' || outputFilename.trim() === '') {
        return `trimmed_${compressionMode}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.mp4`;
    }

    let normalized = outputFilename.trim();
    if (!normalized.toLowerCase().endsWith('.mp4')) {
        normalized += '.mp4';
    }
    if (
        normalized === '.' ||
        normalized === '..' ||
        /[<>:"/\\|?*\x00-\x1f]/.test(normalized) ||
        normalized.endsWith('.') ||
        normalized.endsWith(' ')
    ) {
        const error = new Error('Output file name contains invalid characters');
        error.statusCode = 400;
        throw error;
    }
    return normalized;
}

async function createOutputTarget(outputDirectory, compressionMode, requestedFilename) {
    const outputDir = await resolveOutputDirectory(outputDirectory);
    const outputFilename = normalizeOutputFilename(requestedFilename, compressionMode);
    const outputPath = path.join(outputDir, outputFilename);

    try {
        await fs.access(outputPath);
        const error = new Error(`A file named "${outputFilename}" already exists in the output folder`);
        error.statusCode = 409;
        throw error;
    } catch (error) {
        if (error?.statusCode === 409) throw error;
        if (error?.code !== 'ENOENT') throw error;
    }

    return {
        outputFilename,
        outputPath,
        outputDirectory: outputDir
    };
}

// Helper function to calculate target video bitrate based on desired output size percentage or fixed size
async function calculateTargetBitrate(inputPath, targetSizePercent, duration = null, targetSizeMB = null) {
    const metadata = await probeMedia(inputPath);

            // Get file size in bytes 
            let fileSizeInBytes = metadata.format.size ? parseInt(metadata.format.size, 10) : null;
            if (!fileSizeInBytes || !Number.isFinite(fileSizeInBytes)) {
                try {
                    fileSizeInBytes = fsSync.statSync(inputPath).size;
                } catch (e) {
                    throw e;
                }
            }

            const fullDuration = metadata.format.duration;
            if (!fullDuration || !Number.isFinite(fullDuration) || fullDuration <= 0) {
                throw new Error('Could not determine media duration for bitrate calculation');
            }

            // Output segment length (trim window). When encoding from original + -ss/-t, this is the
            // requested trim duration; target bitrates are spread over this length. Source average
            // bitrate always uses the full file size / full duration.
            const outputDuration =
                duration != null && Number.isFinite(duration) && duration > 0 ? duration : fullDuration;

            const segmentSizeBytes = fileSizeInBytes * Math.min(1, outputDuration / fullDuration);

            // Get audio bitrate (or estimate if not available)
            const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
            const audioBitrate = audioStream?.bit_rate ? parseInt(audioStream.bit_rate) : 128000; // Default to 128kbps
            
            // Average bitrate of the source file (bits per second)
            const currentTotalBitrate = (fileSizeInBytes * 8) / fullDuration;
            
            // Calculate current video bitrate by subtracting audio bitrate
            const currentVideoBitrate = Math.max(currentTotalBitrate - audioBitrate, 100000); // Ensure minimum
            
            // Calculate target total file size in bytes
            let targetFileSizeBytes;
            if (targetSizeMB !== null) {
                // Use fixed target size in MB
                targetFileSizeBytes = targetSizeMB * 1024 * 1024;
                console.log(`🎯 Using fixed target size: ${targetSizeMB} MB`);
            } else {
                if (targetSizePercent == null || !Number.isFinite(targetSizePercent)) {
                    throw new Error('targetSizePercent is required when targetSizeMB is not set');
                }
                // Percentage of the proportional size of the segment being exported
                targetFileSizeBytes = segmentSizeBytes * (targetSizePercent / 100);
                console.log(`🎯 Using percentage-based target size: ${targetSizePercent}% of segment`);
            }
            
            // Calculate target total bitrate - account for container overhead (~2%)
            const containerOverheadFactor = 0.98; // 2% overhead for container
            const targetTotalBitrate = (targetFileSizeBytes * 8 * containerOverheadFactor) / outputDuration;
            
            // Calculate target video bitrate by subtracting audio bitrate
            const targetVideoBitrate = Math.max(targetTotalBitrate - audioBitrate, 100000); // Minimum 100kbps
            
            // For more accurate results, don't limit to current bitrate for compression modes
            let finalVideoBitrate = targetVideoBitrate;
            
            // Only apply the "don't exceed original" constraint for very small targets
            if (targetSizeMB && targetSizeMB < 50) {
                // For very aggressive compression, we might need to go below original
                finalVideoBitrate = targetVideoBitrate;
            } else if (!targetSizeMB) {
                // For percentage-based compression, respect original limits
                finalVideoBitrate = Math.min(targetVideoBitrate, currentVideoBitrate);
            }
            
            const finalAudioBitrate = Math.min(audioBitrate, 320000); // Cap audio at 320kbps
            
            console.log(`📊 Bitrate Calculation Details:`);
            console.log(`   Original file size: ${(fileSizeInBytes / (1024 * 1024)).toFixed(2)} MB`);
            console.log(`   Full duration: ${fullDuration.toFixed(2)}s, output segment: ${outputDuration.toFixed(2)}s`);
            console.log(`   Current total bitrate: ${(currentTotalBitrate / 1000).toFixed(0)} kbps`);
            console.log(`   Current video bitrate: ${(currentVideoBitrate / 1000).toFixed(0)} kbps`);
            console.log(`   Current audio bitrate: ${(audioBitrate / 1000).toFixed(0)} kbps`);
            console.log(`   Target file size: ${(targetFileSizeBytes / (1024 * 1024)).toFixed(2)} MB`);
            console.log(`   Target video bitrate: ${(finalVideoBitrate / 1000).toFixed(0)} kbps`);
            console.log(`   Target audio bitrate: ${(finalAudioBitrate / 1000).toFixed(0)} kbps`);
            
            return {
                targetVideoBitrate: Math.round(finalVideoBitrate),
                audioBitrate: Math.round(finalAudioBitrate),
                currentVideoBitrate: Math.round(currentVideoBitrate),
                compressionRatio: ((currentVideoBitrate - finalVideoBitrate) / currentVideoBitrate * 100).toFixed(1)
            };
}

const DEFAULT_COMPRESSION_MODE = 'balanced';
const HARDWARE_ACCELERATION_CODEC_MAP = new Map([
    ['h264', 'h264_nvenc'],
    ['libx264', 'h264_nvenc'],
    ['h265', 'hevc_nvenc'],
    ['hevc', 'hevc_nvenc'],
    ['libx265', 'hevc_nvenc'],
    ['av1', 'av1_nvenc'],
    ['libaom-av1', 'av1_nvenc'],
    ['libsvtav1', 'av1_nvenc'],
    ['librav1e', 'av1_nvenc']
]);
const COMPRESSION_STRATEGIES = new Set(['directCopy', 'bitrateTarget', 'sizeTarget', 'manual']);
const RATE_CONTROL_MODES = new Set(['targetPercent', 'targetSize', 'constantBitrate', 'constantQuality', 'constantQp']);
const hardwareCodecSupportCache = new Map();

function toFiniteNumber(value, fallback = null) {
    if (value === null || value === undefined || value === '') {
        return fallback;
    }
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function toPositiveNumber(value, fallback = null) {
    const number = toFiniteNumber(value, fallback);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeOptionalString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function slugifyPresetId(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}

function inferProcessingStrategy(preset) {
    if (preset.processingStrategy) return preset.processingStrategy;
    if (preset.rateControl === 'targetSize') return 'sizeTarget';
    if (preset.rateControl === 'targetPercent') return 'bitrateTarget';
    return 'manual';
}

function normalizeCompressionPreset(preset) {
    if (!preset || typeof preset !== 'object') {
        throw new Error('Compression preset must be an object');
    }

    const id = preset.builtIn
        ? String(preset.id || preset.name || '').trim()
        : slugifyPresetId(preset.id || preset.name);
    if (!id) {
        throw new Error('Compression preset is missing an id');
    }

    const processingStrategy = inferProcessingStrategy(preset);
    if (!COMPRESSION_STRATEGIES.has(processingStrategy)) {
        throw new Error(`Compression preset "${id}" uses unsupported strategy "${processingStrategy}"`);
    }

    const rateControl = RATE_CONTROL_MODES.has(preset.rateControl)
        ? preset.rateControl
        : processingStrategy === 'directCopy'
            ? null
            : processingStrategy === 'sizeTarget'
            ? 'targetSize'
            : processingStrategy === 'bitrateTarget'
                ? 'targetPercent'
                : 'constantQuality';

    const targetSizePercent = toFiniteNumber(preset.targetSizePercent);
    const targetSizeMB = toFiniteNumber(preset.targetSizeMB);
    const sizeLimitMB = toFiniteNumber(preset.sizeLimitMB, targetSizeMB);
    const bitrateKbps = toPositiveNumber(preset.bitrateKbps);
    const maxrateKbps = toPositiveNumber(preset.maxrateKbps);
    const bufsizeKbps = toPositiveNumber(preset.bufsizeKbps);
    const audioBitrateKbps = toPositiveNumber(preset.audioBitrateKbps);
    const crf = toFiniteNumber(preset.crf);
    const qp = toFiniteNumber(preset.qp);
    const width = toPositiveNumber(preset.width);
    const height = toPositiveNumber(preset.height);
    const fps = toPositiveNumber(preset.fps);
    const audioSampleRate = toPositiveNumber(preset.audioSampleRate);
    const audioChannels = toPositiveNumber(preset.audioChannels);

    if (processingStrategy === 'bitrateTarget' && !Number.isFinite(targetSizePercent)) {
        throw new Error(`Compression preset "${id}" must define targetSizePercent`);
    }

    if (processingStrategy === 'sizeTarget' && !Number.isFinite(targetSizeMB)) {
        throw new Error(`Compression preset "${id}" must define targetSizeMB`);
    }

    if (processingStrategy === 'manual' && rateControl === 'constantBitrate' && !Number.isFinite(bitrateKbps)) {
        throw new Error(`Compression preset "${id}" must define bitrateKbps for constant bitrate`);
    }

    if (processingStrategy === 'manual' && rateControl === 'constantQuality' && !Number.isFinite(crf)) {
        throw new Error(`Compression preset "${id}" must define crf for constant quality`);
    }

    if (processingStrategy === 'manual' && rateControl === 'constantQp' && !Number.isFinite(qp)) {
        throw new Error(`Compression preset "${id}" must define qp for constant QP`);
    }

    return {
        id,
        name: String(preset.name || id),
        description: String(preset.description || ''),
        processingStrategy,
        rateControl,
        videoCodec: String(preset.videoCodec || 'libx265'),
        audioCodec: String(preset.audioCodec || 'aac'),
        options: Array.isArray(preset.options) ? preset.options.map(String) : [],
        extraOptions: Array.isArray(preset.extraOptions) ? preset.extraOptions.map(String) : [],
        targetSizePercent,
        targetSizeMB,
        sizeLimitMB,
        sizeLabel: typeof preset.sizeLabel === 'string' ? preset.sizeLabel : null,
        bitrateKbps,
        maxrateKbps,
        bufsizeKbps,
        audioBitrateKbps,
        crf,
        qp,
        width,
        height,
        fps,
        encoderPreset: normalizeOptionalString(preset.encoderPreset),
        profile: normalizeOptionalString(preset.profile),
        level: normalizeOptionalString(preset.level),
        tune: normalizeOptionalString(preset.tune),
        pixelFormat: normalizeOptionalString(preset.pixelFormat) || 'yuv420p',
        audioSampleRate,
        audioChannels,
        estimatedTime: preset.estimatedTime,
        qualityLevel: preset.qualityLevel,
        builtIn: Boolean(preset.builtIn)
    };
}

function createCompressionPresetRegistry(presets, builtInCount = presets.length) {
    const registry = {};

    presets.forEach((preset, index) => {
        const normalized = normalizeCompressionPreset({
            ...preset,
            builtIn: index < builtInCount
        });
        if (registry[normalized.id]) {
            throw new Error(`Duplicate compression preset id "${normalized.id}"`);
        }
        registry[normalized.id] = normalized;
    });

    if (!registry[DEFAULT_COMPRESSION_MODE]) {
        throw new Error(`Default compression preset "${DEFAULT_COMPRESSION_MODE}" is not registered`);
    }

    return registry;
}

function loadCustomCompressionPresets() {
    if (!fsSync.existsSync(CUSTOM_COMPRESSION_PRESETS_PATH)) return [];

    try {
        const raw = fsSync.readFileSync(CUSTOM_COMPRESSION_PRESETS_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.warn(`Could not load custom compression presets: ${error.message}`);
        return [];
    }
}

let customCompressionPresets = loadCustomCompressionPresets();
let COMPRESSION_MODES = createCompressionPresetRegistry(
    [...builtInCompressionPresets, ...customCompressionPresets],
    builtInCompressionPresets.length
);

async function saveCustomCompressionPresets() {
    await fs.writeFile(
        CUSTOM_COMPRESSION_PRESETS_PATH,
        JSON.stringify(customCompressionPresets, null, 2),
        'utf8'
    );
}

function rebuildCompressionPresetRegistry() {
    COMPRESSION_MODES = createCompressionPresetRegistry(
        [...builtInCompressionPresets, ...customCompressionPresets],
        builtInCompressionPresets.length
    );
}

function isHardwareAccelerationEnabled(job) {
    return Boolean(job && job.hardwareAcceleration);
}

function getAcceleratedVideoCodec(videoCodec, hardwareAcceleration) {
    if (!hardwareAcceleration) return videoCodec;
    return HARDWARE_ACCELERATION_CODEC_MAP.get(videoCodec) || videoCodec;
}

function testHardwareCodecSupport(codec) {
    if (hardwareCodecSupportCache.has(codec)) {
        return hardwareCodecSupportCache.get(codec);
    }

    const supportPromise = new Promise((resolve) => {
        const args = [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            // Some hardware HEVC encoders reject 64x64 even though they support
            // normal video resolutions, which causes a false-negative probe.
            'color=c=black:s=640x360:d=0.1:r=1',
            '-frames:v',
            '1',
            '-an',
            '-c:v',
            codec,
            '-f',
            'null',
            '-'
        ];
        const ffmpegProcess = spawn('ffmpeg', args, { windowsHide: true });
        let stderrOutput = '';

        ffmpegProcess.stderr.on('data', (data) => {
            stderrOutput += data.toString();
            if (stderrOutput.length > 4000) {
                stderrOutput = stderrOutput.slice(-4000);
            }
        });

        ffmpegProcess.on('close', (code) => {
            if (code === 0) {
                resolve({ supported: true, reason: null });
            } else {
                resolve({
                    supported: false,
                    reason: stderrOutput.trim() || `ffmpeg exited with code ${code}`
                });
            }
        });

        ffmpegProcess.on('error', (error) => {
            resolve({ supported: false, reason: error.message });
        });
    });

    hardwareCodecSupportCache.set(codec, supportPromise);
    return supportPromise;
}

async function resolveVideoCodecForEncoding(videoCodec, hardwareAcceleration, job = null) {
    const acceleratedCodec = getAcceleratedVideoCodec(videoCodec, hardwareAcceleration);
    if (!hardwareAcceleration || acceleratedCodec === videoCodec || videoCodec === 'copy') {
        return {
            videoCodec,
            hardwareAcceleration: false
        };
    }

    const support = await testHardwareCodecSupport(acceleratedCodec);
    if (support.supported) {
        return {
            videoCodec: acceleratedCodec,
            hardwareAcceleration: true
        };
    }

    console.warn(
        `Hardware encoder ${acceleratedCodec} is unavailable; using software codec ${videoCodec}. ${support.reason}`
    );
    if (job) {
        job.hardwareAcceleration = false;
        job.hardwareAccelerationFallbackAttempted = true;
        job.progressMessage = `Hardware encoder ${acceleratedCodec} is unavailable; using software encoding...`;
    }
    return {
        videoCodec,
        hardwareAcceleration: false
    };
}

function getHardwareInputOptions(videoCodec, hardwareAcceleration) {
    if (!hardwareAcceleration || videoCodec === 'copy') return [];
    return [];
}

function shouldDropHardwareOption(option, videoCodec) {
    const normalized = option.trim().toLowerCase();
    const optionName = normalized.split(/\s+/)[0];
    const hardwarePresetOptions = new Set(['-preset']);
    const profileOptions = new Set(['-profile:v', '-profile', '-level']);
    const softwareAv1Options = new Set([
        '-aom-params',
        '-cpu-used',
        '-row-mt',
        '-svtav1-params'
    ]);

    if (hardwarePresetOptions.has(optionName) || profileOptions.has(optionName)) return true;
    if (videoCodec === 'av1_nvenc' && softwareAv1Options.has(optionName)) return true;
    if (videoCodec === 'av2_nvenc' && softwareAv1Options.has(optionName)) return true;
    return false;
}

function getPresetOptionsForAcceleration(options, hardwareAcceleration, videoCodec) {
    if (!hardwareAcceleration) return options;

    const filteredOptions = [];
    for (let index = 0; index < options.length; index++) {
        const option = options[index];
        if (shouldDropHardwareOption(option, videoCodec)) {
            if (!option.trim().includes(' ') && index + 1 < options.length) {
                index++;
            }
            continue;
        }
        filteredOptions.push(option);
    }

    return ['-preset', 'medium', ...filteredOptions];
}

function supportsConstrainedBitrateOptions(videoCodec) {
    return videoCodec !== 'libsvtav1';
}

function buildStructuredEncodingOptions(preset, bitrateContext = {}, encodingContext = {}) {
    const options = ['-movflags', '+faststart'];
    const pixelFormat = preset.pixelFormat || 'yuv420p';
    const videoCodec = encodingContext.videoCodec || preset.videoCodec;
    const hardwareCodecOverride =
        encodingContext.hardwareAcceleration && encodingContext.videoCodec !== preset.videoCodec;

    if (pixelFormat) {
        options.push('-pix_fmt', pixelFormat);
    }

    if (!hardwareCodecOverride) {
        if (preset.encoderPreset) options.push('-preset', preset.encoderPreset);
        if (preset.profile) options.push('-profile:v', preset.profile);
        if (preset.level) options.push('-level', preset.level);
        if (preset.tune) options.push('-tune', preset.tune);
    }
    if (preset.fps) options.push('-r', String(preset.fps));

    if (preset.width || preset.height) {
        const width = preset.width ? Math.round(preset.width) : -2;
        const height = preset.height ? Math.round(preset.height) : -2;
        options.push('-vf', `scale=${width}:${height}`);
    }

    const targetVideoBitrate = bitrateContext.targetVideoBitrate;
    const audioBitrate = bitrateContext.audioBitrate;

    if (Number.isFinite(targetVideoBitrate)) {
        options.push('-b:v', String(targetVideoBitrate));
        if (supportsConstrainedBitrateOptions(videoCodec)) {
            options.push(
                '-maxrate',
                String(Math.round(targetVideoBitrate * 1.5)),
                '-bufsize',
                String(Math.round(targetVideoBitrate * 2))
            );
        }
    } else if (preset.rateControl === 'constantBitrate') {
        const bitrate = Math.round(preset.bitrateKbps * 1000);
        options.push('-b:v', String(bitrate));
        if (supportsConstrainedBitrateOptions(videoCodec)) {
            if (preset.maxrateKbps) options.push('-maxrate', String(Math.round(preset.maxrateKbps * 1000)));
            if (preset.bufsizeKbps) options.push('-bufsize', String(Math.round(preset.bufsizeKbps * 1000)));
        }
    } else if (preset.rateControl === 'constantQuality') {
        options.push('-crf', String(preset.crf));
    } else if (preset.rateControl === 'constantQp') {
        options.push('-qp', String(preset.qp));
    }

    if (preset.audioCodec !== 'copy') {
        if (Number.isFinite(audioBitrate)) {
            options.push('-b:a', String(audioBitrate));
        } else if (preset.audioBitrateKbps) {
            options.push('-b:a', `${Math.round(preset.audioBitrateKbps)}k`);
        }
        if (preset.audioSampleRate) options.push('-ar', String(Math.round(preset.audioSampleRate)));
        if (preset.audioChannels) options.push('-ac', String(Math.round(preset.audioChannels)));
    }

    return options;
}

function isJobCancelled(job) {
    return Boolean(job && job.status === 'cancelled');
}

function terminateFfmpegProcess(job, jobId) {
    const ffmpegProcess = job?.ffmpegProcess;
    if (!ffmpegProcess) {
        return false;
    }

    const pid = ffmpegProcess.pid;
    try {
        if (process.platform === 'win32' && pid) {
            const taskkill = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
                stdio: ['ignore', 'ignore', 'pipe'],
                windowsHide: true
            });

            let stderrOutput = '';
            taskkill.stderr.on('data', (data) => {
                stderrOutput += data.toString();
            });
            taskkill.on('close', (code) => {
                if (code === 0) {
                    console.log(`Killed FFmpeg process tree for job ${jobId} (PID ${pid})`);
                } else if (stderrOutput.trim()) {
                    console.warn(`taskkill for job ${jobId} exited with code ${code}: ${stderrOutput.trim()}`);
                }
            });
        }

        ffmpegProcess.kill('SIGTERM');
        setTimeout(() => {
            if (ffmpegProcess.exitCode == null && ffmpegProcess.signalCode == null) {
                try {
                    ffmpegProcess.kill('SIGKILL');
                } catch {
                    // The process may have already exited.
                }
            }
        }, 1500);
        return true;
    } catch (error) {
        console.warn(`Could not kill FFmpeg process for job ${jobId}: ${error.message}`);
        return false;
    }
}

// Ensure directories exist
async function ensureDirectories() {
    try {
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
        await fs.mkdir(OUTPUT_DIR, { recursive: true });
        await fs.mkdir(TEMP_DIR, { recursive: true });
        console.log('Directories created successfully');
    } catch (error) {
        console.error('Error creating directories:', error);
    }
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const extension = path.extname(path.basename(file.originalname)).toLowerCase();
        cb(null, `${crypto.randomUUID()}${extension}`);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 8 },
    fileFilter: (req, file, cb) => {
        const allowedExtensions = new Set([
            '.mp4', '.webm', '.avi', '.mov', '.mkv', '.mpeg', '.mpg', '.m4v', '.ogv', '.ogg', '.3gp'
        ]);
        const allowedMimes = [
            'video/mp4',
            'video/mpeg',
            'video/quicktime',
            'video/x-msvideo',
            'video/mkv',
            'video/webm',
            'video/ogg',
            'video/3gpp'
        ];
        
        if (allowedMimes.includes(file.mimetype) && allowedExtensions.has(path.extname(file.originalname).toLowerCase())) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Please upload a video file.'));
        }
    }
});

// Job tracking for async processing
const jobs = new Map();

// Helper function to get file size in MB
async function getFileSizeMB(filePath) {
    try {
        const stats = await fs.stat(filePath);
        return (stats.size / (1024 * 1024)).toFixed(2);
    } catch (error) {
        return 'Unknown';
    }
}

// Helper function to format elapsed time
function formatElapsedTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${secs}s`;
    } else {
        return `${secs}s`;
    }
}

function parseFfmpegTimemark(timemark) {
    if (typeof timemark !== 'string') return null;

    const parts = timemark.split(':');
    if (parts.length !== 3) return null;

    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    const seconds = Number(parts[2]);

    if (![hours, minutes, seconds].every(Number.isFinite)) return null;
    return hours * 3600 + minutes * 60 + seconds;
}

function getEncodingProgressPercent(progress, expectedDurationSeconds) {
    if (Number.isFinite(expectedDurationSeconds) && expectedDurationSeconds > 0) {
        const encodedSeconds = parseFfmpegTimemark(progress?.timemark);
        if (encodedSeconds != null) {
            return Math.max(0, Math.min(99.5, (encodedSeconds / expectedDurationSeconds) * 100));
        }
    }

    if (Number.isFinite(progress?.percent)) {
        return Math.max(0, Math.min(99.5, progress.percent));
    }

    return null;
}

function formatProgressPercent(percent) {
    if (!Number.isFinite(percent)) return 0;
    const rounded = Math.round(percent * 10) / 10;
    return Number.isInteger(rounded) ? Math.round(rounded) : rounded;
}

// Enhanced cleanup function that runs periodically
async function cleanupOldFiles() {
    console.log('Running cleanup task...');
    const directories = [UPLOAD_DIR, OUTPUT_DIR, TEMP_DIR];
    const maxAge = 24 * 60 * 60 * 1000; // 1 day
    let cleanedCount = 0;
    
    // Clean up uploaded videos map
    const now = Date.now();
    for (const [videoId, videoInfo] of uploadedVideos.entries()) {
        const uploadTime = new Date(videoInfo.uploadedAt).getTime();
        if (now - uploadTime > maxAge) {
            if (videoInfo.external) {
                uploadedVideos.delete(videoId);
                continue;
            }

            try {
                await fs.unlink(videoInfo.path);
                uploadedVideos.delete(videoId);
                cleanedCount++;
                console.log(`Cleaned up old uploaded video: ${videoInfo.originalName}`);
            } catch (error) {
                console.warn(`Could not delete uploaded video: ${error.message}`);
            }
        }
    }

    for (const dir of directories) {
        try {
            const files = await fs.readdir(dir);
            
            for (const file of files) {
                const filePath = path.join(dir, file);
                try {
                    const stats = await fs.stat(filePath);
                    const age = Date.now() - stats.mtime.getTime();
                    
                    console.log(`File ${file} age: ${(age / 1000).toFixed(0)}s (max: ${(maxAge / 1000).toFixed(0)}s)`);
                    
                    if (age > maxAge) {
                        const sizeMB = await getFileSizeMB(filePath);
                        await fs.unlink(filePath);
                        console.log(`🗑️  Cleaned up old file: ${file} (${sizeMB} MB)`);
                        cleanedCount++;
                    }
                } catch (error) {
                    console.warn(`Could not process file ${file}:`, error.message);
                }
            }
        } catch (error) {
            console.warn(`Cleanup warning for ${dir}:`, error.message);
        }
    }
    
    // Clean up old jobs
    const jobsToDelete = [];
    for (const [jobId, job] of jobs.entries()) {
        const age = Date.now() - job.createdAt.getTime();
        if (age > maxAge) {
            jobsToDelete.push(jobId);
        }
    }
    
    jobsToDelete.forEach(jobId => {
        jobs.delete(jobId);
        console.log(`Cleaned up old job: ${jobId}`);
    });
    
    console.log(`Cleanup completed. Removed ${cleanedCount} files and ${jobsToDelete.length} old jobs.`);
}

// Run cleanup every 30 minutes while server is running
setInterval(async () => {
    try {
        await cleanupOldFiles();
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}, 30 * 60 * 1000); // 30 minutes

// Initial cleanup on server start
setTimeout(async () => {
    try {
        await cleanupOldFiles();
    } catch (error) {
        console.error('Initial cleanup error:', error);
    }
}, 5000); // Run after 5 seconds of server start

// Root endpoint - welcome message
app.get('/', (req, res) => {
    res.json({
        message: '🎬 Video Trimmer Server with Compression Modes',
        status: 'running',
        version: '2.0.0',
        endpoints: {
            health: '/health',
            init: '/init',
            info: '/info',
            compressionModes: '/compression-modes',
            trim: 'POST /trim',
            status: '/status/:jobId',
        },
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Video trimmer server is running',
        timestamp: new Date().toISOString(),
        activeJobs: jobs.size
    });
});

// Get server info
app.get('/info', (req, res) => {
    res.json({
        server: 'Video Trimmer API with Compression',
        version: '2.0.0',
        activeJobs: jobs.size,
        compressionModes: Object.keys(COMPRESSION_MODES).length,
        endpoints: {
            health: 'GET /health',
            init: 'GET /init',
            compressionModes: 'GET /compression-modes',
            trim: 'POST /trim',
            status: 'GET /status/:jobId',
        }
    });
});

function compressionModesList() {
    return Object.entries(COMPRESSION_MODES).map(([key, config]) => ({
        id: key,
        name: config.name,
        description: config.description,
        processingStrategy: config.processingStrategy,
        rateControl: config.rateControl,
        videoCodec: config.videoCodec,
        audioCodec: config.audioCodec,
        options: config.options,
        extraOptions: config.extraOptions,
        targetSizePercent: config.targetSizePercent,
        targetSizeMB: config.targetSizeMB,
        sizeLimitMB: config.sizeLimitMB,
        sizeLabel: config.sizeLabel,
        bitrateKbps: config.bitrateKbps,
        maxrateKbps: config.maxrateKbps,
        bufsizeKbps: config.bufsizeKbps,
        audioBitrateKbps: config.audioBitrateKbps,
        crf: config.crf,
        qp: config.qp,
        width: config.width,
        height: config.height,
        fps: config.fps,
        encoderPreset: config.encoderPreset,
        profile: config.profile,
        level: config.level,
        tune: config.tune,
        pixelFormat: config.pixelFormat,
        audioSampleRate: config.audioSampleRate,
        audioChannels: config.audioChannels,
        estimatedTime: config.estimatedTime,
        qualityLevel: config.qualityLevel,
        builtIn: config.builtIn
    }));
}

// Single round-trip for app startup (health + modes) to shorten the request chain
app.get('/init', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
        status: 'ok',
        message: 'Video trimmer server is running',
        timestamp: new Date().toISOString(),
        activeJobs: jobs.size,
        modes: compressionModesList(),
        default: DEFAULT_COMPRESSION_MODE
    });
});

// Get available compression modes
app.get('/compression-modes', (req, res) => {
    res.set('Cache-Control', 'public, max-age=120');
    res.json({
        message: 'Available compression modes',
        modes: compressionModesList(),
        default: DEFAULT_COMPRESSION_MODE
    });
});

// Check the latest published GitHub release without exposing GitHub to the webview CSP.
app.get('/update-check', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        res.json(await checkForUpdate(APP_VERSION));
    } catch (error) {
        console.warn(`Update check failed: ${error.message}`);
        if (error.code === 'NO_PUBLIC_RELEASE') {
            return res.status(404).json({ error: 'No public releases are available yet.' });
        }
        res.status(502).json({ error: 'Could not check for updates. Please try again later.' });
    }
});

app.post('/compression-modes/custom', async (req, res) => {
    try {
        const normalized = normalizeCompressionPreset(req.body);
        if (COMPRESSION_MODES[normalized.id]) {
            return res.status(409).json({ error: `Compression preset "${normalized.id}" already exists` });
        }

        const presetToStore = { ...normalized, builtIn: false };
        customCompressionPresets.push(presetToStore);
        rebuildCompressionPresetRegistry();
        await saveCustomCompressionPresets();

        res.status(201).json({
            message: 'Compression preset created',
            preset: COMPRESSION_MODES[normalized.id],
            modes: compressionModesList(),
            default: DEFAULT_COMPRESSION_MODE
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.put('/compression-modes/custom/:id', async (req, res) => {
    try {
        const presetId = slugifyPresetId(req.params.id);
        const existingIndex = customCompressionPresets.findIndex((preset) => slugifyPresetId(preset.id) === presetId);
        if (existingIndex === -1) {
            if (COMPRESSION_MODES[presetId]?.builtIn) {
                return res.status(403).json({ error: 'Built-in compression guides cannot be edited' });
            }
            return res.status(404).json({ error: 'Compression preset not found' });
        }

        const normalized = normalizeCompressionPreset({
            ...req.body,
            id: req.body.id || presetId,
            builtIn: false
        });
        const duplicate = COMPRESSION_MODES[normalized.id];
        if (normalized.id !== presetId && duplicate) {
            return res.status(409).json({ error: `Compression preset "${normalized.id}" already exists` });
        }

        customCompressionPresets[existingIndex] = { ...normalized, builtIn: false };
        rebuildCompressionPresetRegistry();
        await saveCustomCompressionPresets();

        res.json({
            message: 'Compression preset updated',
            preset: COMPRESSION_MODES[normalized.id],
            modes: compressionModesList(),
            default: DEFAULT_COMPRESSION_MODE
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.delete('/compression-modes/custom/:id', async (req, res) => {
    try {
        const presetId = slugifyPresetId(req.params.id);
        if (COMPRESSION_MODES[presetId]?.builtIn) {
            return res.status(403).json({ error: 'Built-in compression guides cannot be deleted' });
        }

        const nextPresets = customCompressionPresets.filter((preset) => slugifyPresetId(preset.id) !== presetId);
        if (nextPresets.length === customCompressionPresets.length) {
            return res.status(404).json({ error: 'Compression preset not found' });
        }

        customCompressionPresets = nextPresets;
        rebuildCompressionPresetRegistry();
        await saveCustomCompressionPresets();

        res.json({
            message: 'Compression preset deleted',
            modes: compressionModesList(),
            default: DEFAULT_COMPRESSION_MODE
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Check if video exists before uploading (saves resources)
app.post('/check-video', express.json(), async (req, res) => {
    try {
        const { filename, size } = req.body;
        
        if (!filename || !size) {
            return res.status(400).json({ error: 'Filename and size are required' });
        }
        
        const inputSizeMB = (size / (1024 * 1024)).toFixed(2);
        
        // Check if video already exists in our tracking
        let existingVideoId = null;
        
        // First check in uploadedVideos map
        for (const [videoId, info] of uploadedVideos.entries()) {
            if (info.originalName === filename && info.size == inputSizeMB) {
                existingVideoId = videoId;
                console.log(`Video "${filename}" already tracked with ID: ${videoId}`);
                break;
            }
        }
        
        // If found in map, check if file still exists on disk
        if (existingVideoId) {
            try {
                await fs.access(uploadedVideos.get(existingVideoId).path);
                // File exists, return existing ID
                return res.json({
                    exists: true,
                    videoId: existingVideoId,
                    status: 'already_uploaded',
                    message: 'Video already exists on server',
                    originalName: filename,
                    size: inputSizeMB
                });
            } catch (e) {
                // File was deleted, remove from map
                console.log(`File "${filename}" was in map but not on disk`);
                uploadedVideos.delete(existingVideoId);
                existingVideoId = null;
            }
        }
        
        // File doesn't exist, needs to be uploaded
        return res.json({
            exists: false,
            message: 'Video does not exist, upload required'
        });
    } catch (error) {
        console.error('Check video endpoint error:', error);
        res.status(500).json({ 
            error: 'Internal server error',
            message: error.message 
        });
    }
});

// New upload endpoint for background upload
app.post('/upload', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No video file uploaded' });
        }

        const originalName = path.basename(req.file.originalname);
        const fileSize = req.file.size;
        const filePath = req.file.path;
        
        // Double-check if video already exists (in case check wasn't called)
        let existingVideoId = null;
        let inputSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
        
        // First check in uploadedVideos map
        for (const [videoId, info] of uploadedVideos.entries()) {
            if (info.originalName === originalName && info.size == inputSizeMB) {
                existingVideoId = videoId;
                console.log(`Video "${originalName}" already tracked with ID: ${videoId}`);
                break;
            }
        }
        
        // If found in map, check if file still exists on disk
        if (existingVideoId) {
            try {
                await fs.access(uploadedVideos.get(existingVideoId).path);
                await fs.unlink(filePath).catch(() => {});
                // File exists, return existing ID
                return res.json({
                    videoId: existingVideoId,
                    status: 'already_uploaded',
                    message: 'Video already exists on server',
                    originalName: originalName,
                    size: inputSizeMB
                });
            } catch (e) {
                // File was deleted, remove from map and continue with upload
                console.log(`File "${originalName}" was in map but not on disk, re-uploading`);
                uploadedVideos.delete(existingVideoId);
                existingVideoId = null;
            }
        }
        
        const videoId = crypto.randomUUID();
        uploadedVideos.set(videoId, {
            id: videoId,
            path: filePath,
            originalName: originalName,
            size: inputSizeMB,
            uploadedAt: new Date().toISOString()
        });
        
        console.log(`Video "${originalName}" uploaded successfully with ID: ${videoId}`);

        res.json({
            videoId,
            status: 'uploaded',
            message: 'Video uploaded successfully',
            originalName: originalName,
            size: inputSizeMB
        });
    } catch (error) {
        if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
        console.error('Upload endpoint error:', error);
        res.status(500).json({ 
            error: 'Internal server error',
            message: error.message 
        });
    }
});

const LIBRARY_VIDEO_EXT = new Set([
    '.mp4', '.webm', '.avi', '.mov', '.mkv', '.mpeg', '.mpg', '.m4v', '.ogv', '.ogg', '.3gp'
]);

function isAllowedLibraryVideoBasename(name) {
    return LIBRARY_VIDEO_EXT.has(path.extname(name).toLowerCase());
}

app.post('/upload-from-path', async (req, res) => {
    try {
        const rawPath = req.body?.path;
        if (!rawPath || typeof rawPath !== 'string') {
            return res.status(400).json({ error: 'path is required (absolute path to the video file)' });
        }

        let sourcePath = path.resolve(rawPath.trim());
        let srcStat;
        try {
            srcStat = await fs.stat(sourcePath);
        } catch {
            return res.status(400).json({ error: 'Source file not found or not readable' });
        }

        if (!srcStat.isFile()) {
            return res.status(400).json({ error: 'path must be a regular file' });
        }
        sourcePath = await fs.realpath(sourcePath);
        if (!(await isAuthorizedInputPath(sourcePath))) {
            return res.status(403).json({ error: 'File is outside the folders selected in the native picker' });
        }
        if (srcStat.size === 0) {
            return res.status(400).json({ error: 'File is empty' });
        }
        if (srcStat.size > MAX_UPLOAD_BYTES) {
            return res.status(413).json({ error: 'File exceeds the 10 GB maximum size' });
        }

        const originalName = path.basename(sourcePath);
        if (!isAllowedLibraryVideoBasename(originalName)) {
            return res.status(400).json({ error: 'Unsupported or missing video file extension' });
        }

        const inputSizeMB = (srcStat.size / (1024 * 1024)).toFixed(2);

        let existingVideoId = null;
        for (const [videoId, info] of uploadedVideos.entries()) {
            if (info.path === sourcePath && info.size == inputSizeMB) {
                existingVideoId = videoId;
                break;
            }
        }

        if (existingVideoId) {
            return res.json({
                videoId: existingVideoId,
                status: 'already_uploaded',
                message: 'Video already registered from source path',
                originalName,
                size: inputSizeMB
            });
        }

        const videoId = crypto.randomUUID();
        uploadedVideos.set(videoId, {
            id: videoId,
            path: sourcePath,
            originalName,
            size: inputSizeMB,
            uploadedAt: new Date().toISOString(),
            external: true
        });

        console.log(`Video "${originalName}" registered from library path with ID: ${videoId}`);

        return res.json({
            videoId,
            status: 'registered',
            message: 'Video registered successfully',
            originalName,
            size: inputSizeMB
        });
    } catch (error) {
        console.error('upload-from-path error:', error);
        return res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

// Modified trim endpoint to use videoId
app.post('/trim', express.json(), async (req, res) => {
    try {
        const { videoId, startTime, endTime, compressionMode = DEFAULT_COMPRESSION_MODE, tracks, outputDirectory, outputFilename } = req.body;
        const hardwareAcceleration = req.body.hardwareAcceleration === true;
        
        // Multi-track support
        if (Array.isArray(tracks) && tracks.length > 1) {
            // Validate compression mode
            if (!COMPRESSION_MODES[compressionMode]) {
                return res.status(400).json({ 
                    error: 'Invalid compression mode',
                    availableModes: Object.keys(COMPRESSION_MODES)
                });
            }
            // Validate and build tracks array for job
            const jobTracks = [];
            for (const t of tracks) {
                if (!t.videoId) {
                    return res.status(400).json({ error: 'Each track must have a videoId' });
                }
                const videoInfo = uploadedVideos.get(t.videoId);
                if (!videoInfo) {
                    return res.status(404).json({ error: 'One of the tracks was not found. Please upload all videos first.' });
                }
                if (typeof t.startTime !== 'number' || typeof t.endTime !== 'number' || t.startTime >= t.endTime) {
                    return res.status(400).json({ error: 'Invalid start/end time in one of the tracks' });
                }
                jobTracks.push({
                    inputPath: videoInfo.path,
                    startTime: t.startTime,
                    endTime: t.endTime
                });
            }
            const outputTarget = await createOutputTarget(outputDirectory, compressionMode, outputFilename);
            const compressionConfig = COMPRESSION_MODES[compressionMode];
            const jobId = crypto.randomUUID();
            const createdAt = new Date();
            jobs.set(jobId, {
                id: jobId,
                status: 'processing',
                tracks: jobTracks,
                outputPath: outputTarget.outputPath,
                outputFilename: outputTarget.outputFilename,
                outputDirectory: outputTarget.outputDirectory,
                compressionMode: compressionMode,
                compressionName: compressionConfig.name,
                hardwareAcceleration,
                progress: 0,
                progressMessage: 'Starting...',
                createdAt: createdAt,
                createdAtISO: createdAt.toISOString(),
            });
            processVideoAsync(jobId);
            res.json({
                jobId,
                status: 'processing',
                message: 'Combining and processing tracks',
                compressionMode: compressionMode,
                compressionName: compressionConfig.name,
                hardwareAcceleration,
                estimatedTime: compressionConfig.estimatedTime,
                qualityLevel: compressionConfig.qualityLevel
            });
            return;
        }

        if (!videoId) {
            return res.status(400).json({ error: 'Video ID is required' });
        }

        const videoInfo = uploadedVideos.get(videoId);
        if (!videoInfo) {
            return res.status(404).json({ error: 'Video not found. Please upload the video first.' });
        }

        if (startTime == null || endTime == null) {
            return res.status(400).json({ error: 'Start time and end time are required' });
        }

        // Validate compression mode
        if (!COMPRESSION_MODES[compressionMode]) {
            return res.status(400).json({ 
                error: 'Invalid compression mode',
                availableModes: Object.keys(COMPRESSION_MODES)
            });
        }

        const startSeconds = Number.parseFloat(startTime);
        const endSeconds = Number.parseFloat(endTime);

        if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
            return res.status(400).json({ error: 'Start time and end time must be valid numbers' });
        }
        
        if (startSeconds >= endSeconds) {
            return res.status(400).json({ error: 'Start time must be less than end time' });
        }

        const outputTarget = await createOutputTarget(outputDirectory, compressionMode, outputFilename);
        
        const compressionConfig = COMPRESSION_MODES[compressionMode];

        // Create a job ID for async processing
        const jobId = crypto.randomUUID();
        
        const createdAt = new Date();
        jobs.set(jobId, {
            id: jobId,
            status: 'processing',
            inputPath: videoInfo.path,
            outputPath: outputTarget.outputPath,
            outputFilename: outputTarget.outputFilename,
            outputDirectory: outputTarget.outputDirectory,
            originalName: videoInfo.originalName,
            inputSize: videoInfo.size,
            startTime: startSeconds,
            endTime: endSeconds,
            compressionMode: compressionMode,
            compressionName: compressionConfig.name,
            hardwareAcceleration,
            progress: 0,
            progressMessage: 'Starting...',
            createdAt: createdAt,
            createdAtISO: createdAt.toISOString(),
            videoId: videoId // Store videoId for cleanup
        });

        // Start async processing
        processVideoAsync(jobId);
        
        // Return immediate response with job ID
        res.json({
            jobId,
            status: 'processing',
            message: 'Video processing started',
            originalName: videoInfo.originalName,
            inputSize: videoInfo.size,
            compressionMode: compressionMode,
            compressionName: compressionConfig.name,
            hardwareAcceleration,
            estimatedTime: compressionConfig.estimatedTime,
            qualityLevel: compressionConfig.qualityLevel
        });

    } catch (error) {
        console.error('Trim endpoint error:', error);
        res.status(error.statusCode || 500).json({
            error: error.statusCode ? error.message : 'Internal server error',
            message: error.message
        });
    }
});

// Job status endpoint
app.get('/status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);
    
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    
    const response = {
        id: job.id,
        status: job.status,
        progress: job.progress,
        progressMessage: job.progressMessage,
        originalName: job.originalName,
        inputSize: job.inputSize,
        compressionMode: job.compressionMode,
        compressionName: job.compressionName,
        hardwareAcceleration: Boolean(job.hardwareAcceleration),
        hardwareAccelerationFallbackAttempted: Boolean(job.hardwareAccelerationFallbackAttempted),
        createdAt: job.createdAtISO,
        iteration: job.currentIteration,
        totalIterations: job.totalIterations
    };
    
    if (job.status === 'completed') {
        response.filename = job.outputFilename;
        response.outputPath = job.outputPath;
        response.outputDirectory = job.outputDirectory || path.dirname(job.outputPath);
        response.outputSize = job.outputSize;
        response.processingTime = job.duration;
        response.compressionRatio = job.compressionRatio;
    } else if (job.status === 'failed') {
        response.error = job.error;
    }
    
    res.json(response);
});

// Cancel job endpoint
app.post('/cancel/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);
    
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    
    if (job.status === 'completed' || job.status === 'failed') {
        return res.status(400).json({ error: 'Job is already finished' });
    }
    
    // Mark job as cancelled
    job.status = 'cancelled';
    job.progress = 0;
    job.progressMessage = 'Cancelled by user';
    job.error = 'Job was cancelled by user';
    
    // Kill the ffmpeg process tree if it exists. On Windows, killing only the
    // parent process can leave hardware encoder children running in the background.
    if (terminateFfmpegProcess(job, jobId)) {
        console.log(`Requested FFmpeg termination for job ${jobId}`);
    }
    
    // Clean up temporary files for this job
    (async () => {
        try {
            // Clean up temp files that might have been created for this job
            const tempFiles = await fs.readdir(TEMP_DIR);
            for (const file of tempFiles) {
                if (file.includes(jobId)) {
                    const filePath = path.join(TEMP_DIR, file);
                    try {
                        await fs.unlink(filePath);
                        console.log(`Cleaned up temp file: ${file}`);
                    } catch (error) {
                        console.warn(`Could not delete temp file ${file}: ${error.message}`);
                    }
                }
            }
            
            // Clean up any partial output files
            if (job.outputPath) {
                try {
                    await fs.unlink(job.outputPath);
                    console.log(`Cleaned up partial output file: ${job.outputFilename}`);
                } catch (error) {
                    // File might not exist yet, that's OK
                }
            }
        } catch (error) {
            console.warn(`Error during cleanup: ${error.message}`);
        }
    })();
    
    console.log(`Job ${jobId} cancelled by user`);
    
    res.json({
        message: 'Job cancelled successfully',
        jobId: jobId,
        status: 'cancelled'
    });
});



// Async video processing function with compression modes
async function processVideoAsync(jobId) {
    const job = jobs.get(jobId);
    if (!job) return;
    
    try {
        job.status = 'processing';
        job.progress = 0;
        job.progressMessage = 'Processing video...';
        job.error = null;

        const outputFilename = job.outputFilename;
        const outputPath = job.outputPath;
        
        console.log(`Starting video processing for job ${jobId}`);
        console.log(`Input: ${job.inputPath}`);
        console.log(`Output: ${outputPath}`);
        console.log(`Compression mode: ${job.compressionMode}`);
        
        // Check if this is a multi-track job
        if (job.tracks && job.tracks.length > 0) {
            console.log(`Processing ${job.tracks.length} tracks`);
            // Normalize every segment before concatenating it. The concat
            // demuxer can only stream-copy tracks whose codec parameters match;
            // otherwise the MP4 uses the first segment's decoder configuration
            // and later video can be undecodable even though its audio plays.
            const processedTracks = [];
            const concatProfile = await getConcatNormalizationProfile(
                job.tracks[0].inputPath,
                isHardwareAccelerationEnabled(job),
                job
            );
            console.log(
                `Concat normalization encoder: ${concatProfile.videoCodec}` +
                (concatProfile.hardwareAcceleration ? ' (GPU)' : ' (CPU)')
            );
            for (let i = 0; i < job.tracks.length; i++) {
                const track = job.tracks[i];
                const trackOutputPath = path.join(TEMP_DIR, `track_${i}_${jobId}.ts`);
                
                console.log(`Processing track ${i + 1}/${job.tracks.length}`);
                
                const onTrackProgress = (progress) => {
                    const trackWeight = 1 / job.tracks.length;
                    const completedTracksProgress = (i * trackWeight) * 100;
                    const currentTrackProgress = (progress * trackWeight);
                    job.progress = Math.round(completedTracksProgress + currentTrackProgress);
                    job.progressMessage = `Processing track ${i + 1}/${job.tracks.length}: ${Math.round(progress)}%`;
                    console.log(`Track ${i + 1} progress: ${Math.round(progress)}%`);
                };

                const trackInfo = await normalizeVideoForConcat(
                    track.inputPath,
                    trackOutputPath,
                    track.startTime,
                    track.endTime,
                    concatProfile,
                    onTrackProgress,
                    job
                );
                
                processedTracks.push({
                    path: trackOutputPath,
                    audioCodec: trackInfo?.audioCodec || null
                });
            }

            console.log(`Combining ${processedTracks.length} tracks`);
            // Combine all processed tracks
            await combineVideoTracks(
                processedTracks,
                outputPath,
                job.compressionMode,
                (progress) => {
                    // For multi-track jobs, we consider track processing complete at this point (100%)
                    // and this is now a new process starting from 0%
                    job.progress = Math.round(progress);
                    job.progressMessage = `Combining tracks: ${Math.round(progress)}%`;
                    console.log(`Combining progress: ${Math.round(progress)}%`);
                },
                job // Pass job object for cancellation
            );

            // Clean up temporary track files
            for (const track of processedTracks) {
                await fs.unlink(track.path);
                console.log(`Cleaned up temporary track file: ${track.path}`);
            }
        } else {
            // Original single video processing
            console.log(`Processing single video`);
            await trimVideoWithCompression(
                job.inputPath,
                outputPath,
                job.startTime,
                job.endTime,
                job.compressionMode,
                (progress) => {
                    job.progress = progress;
                    job.progressMessage = `Processing: ${progress}%`;
                    console.log(`Processing progress: ${progress}%`);
                },
                job // Pass job object for cancellation
            );
        }

        if (isJobCancelled(job)) {
            console.log(`Skipping completion for cancelled job ${jobId}`);
            return;
        }

        // Get output file size
        const stats = await fs.stat(outputPath);
        const outputSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        
        job.status = 'completed';
        job.progress = 100;
        job.outputPath = outputPath;
        job.outputFilename = outputFilename;
        job.outputSize = outputSizeMB;
        job.duration = Math.max(0, (Date.now() - job.createdAt.getTime()) / 1000);
        
        console.log(`Video processing completed successfully`);
        console.log(`Output file: ${outputFilename} (${outputSizeMB} MB)`);
        
    } catch (error) {
        if (isJobCancelled(job)) {
            console.log(`Processing stopped for cancelled job ${jobId}`);
            return;
        }

        if (job.hardwareAcceleration && !job.hardwareAccelerationFallbackAttempted) {
            console.warn(`Hardware acceleration failed for job ${jobId}; retrying with software encoding:`, error.message);
            job.hardwareAcceleration = false;
            job.hardwareAccelerationFallbackAttempted = true;
            job.progress = 0;
            job.progressMessage = 'Hardware acceleration failed; retrying with software encoding...';
            job.error = null;
            job.ffmpegProcess = null;

            try {
                await fs.unlink(job.outputPath);
            } catch {
                // Output may not exist if FFmpeg failed before writing.
            }

            await processVideoAsync(jobId);
            return;
        }

        console.error(`Error processing video for job ${jobId}:`, error);
        job.status = 'failed';
        job.error = error.message;
    }
}

// Core video trimming function with compression modes
function trimVideoWithCompression(inputPath, outputPath, startTime, endTime, compressionMode, progressCallback = null, job = null) {
    return new Promise(async (resolve, reject) => {
        try {
            const duration = endTime - startTime;
            const config = COMPRESSION_MODES[compressionMode];
            const {
                videoCodec,
                hardwareAcceleration
            } = await resolveVideoCodecForEncoding(
                config.videoCodec,
                isHardwareAccelerationEnabled(job),
                job
            );
        
            console.log(`Using compression mode: ${compressionMode} (${config.name})`);
            if (hardwareAcceleration && videoCodec !== config.videoCodec) {
                console.log(`Hardware acceleration enabled: ${config.videoCodec} -> ${videoCodec}`);
            }

            // Stream copy from the original file (no generation loss). Cuts only on keyframes, so
            // the first frame may start slightly before the UI markers — only used when the trim
            // already fits under a size cap without re-encoding.
            async function trimStreamCopyFromOriginal(input, output, start, dur) {
                return new Promise((resolve, reject) => {
                    const endT = start + dur;
                    console.log(`Stream-copy trim: ${start}s to ${endT}s (duration: ${dur}s)`);
                    const trimArgs = [
                        '-ss', String(start),
                        '-to', String(endT),
                        '-i', input,
                        '-fflags', '+genpts',
                        '-c', 'copy',
                        '-copyinkf',
                        '-avoid_negative_ts', 'make_zero',
                        '-reset_timestamps', '1',
                        '-map', '0',
                        output
                    ];

                    console.log(`FFmpeg command: ffmpeg -y ${trimArgs.join(' ')}`);
                    const ff = spawn('ffmpeg', ['-y', ...trimArgs]);

                    if (job) {
                        job.ffmpegProcess = ff;
                    }

                    let stderrOutput = '';
                    ff.stderr.on('data', (data) => {
                        stderrOutput += data.toString();
                    });

                    ff.on('close', (code) => {
                        if (job) job.ffmpegProcess = null;
                        if (code === 0) {
                            console.log(`Stream-copy trim completed`);
                            resolve();
                        } else {
                            console.error(`FFmpeg stream-copy trim failed with code ${code}`);
                            console.error(`FFmpeg stderr: ${stderrOutput}`);
                            reject(new Error(`Failed to stream-copy trim (exit code: ${code})`));
                        }
                    });
                    ff.on('error', (err) => {
                        if (job) job.ffmpegProcess = null;
                        console.error(`FFmpeg process error:`, err);
                        reject(err);
                    });
                });
            }

            // Helper function to get file size in MB
            async function getFileSizeMB(filePath) {
                const stats = await fs.stat(filePath);
                return stats.size / (1024 * 1024);
            }

            // Helper function to do single-pass compression with bitrate adjustment.
            // When trimStartSec + trimDurationSec are set, encodes that window from the original
            // input in one pass (frame-accurate, no intermediate file).
            async function compressWithBitrateAdjustment(input, output, preset, maxIterations = 3, job = null, trimStartSec = null, trimDurationSec = null) {
                let iteration = 0;
                let bitrateReduction = 1.0; // Start with 100% of calculated bitrate
                const targetSizeMB = preset.targetSizeMB;
                const sizeLimitMB = preset.sizeLimitMB;
                
                // Initialize iteration tracking in job
                if (job) {
                    job.currentIteration = 1;
                    job.totalIterations = maxIterations;
                    job.iterationStartTime = Date.now();
                    job.lastIterationSize = null;
                }

                while (iteration < maxIterations) {
                    iteration++;
                    console.log(`[Bitrate Adjustment] Iteration ${iteration}/${maxIterations} (reduction: ${(100 - bitrateReduction * 100).toFixed(0)}%)`);
                    
                    const currentDuration =
                        trimDurationSec != null && Number.isFinite(trimDurationSec) && trimDurationSec > 0
                            ? trimDurationSec
                            : (await probeMedia(input)).format.duration;

                    // Calculate bitrate for target size, then apply reduction
                    const { targetVideoBitrate, audioBitrate } = await calculateTargetBitrate(
                        input,
                        null, // targetSizePercent (null for fixed size)
                        currentDuration, // duration (trim window when encoding from original)
                        targetSizeMB // targetSizeMB
                    );

                    // Apply bitrate reduction only to video bitrate, not audio
                    const adjustedVideoBitrate = Math.round(targetVideoBitrate * bitrateReduction);
                    
                    // Force 192kbps audio for smaller caps, 256kbps for larger files.
                    const finalAudioBitrate = (sizeLimitMB <= 10) ? Math.min(audioBitrate, 192000) : Math.min(audioBitrate, 256000);
                    
                    console.log(`[Iteration ${iteration}] Target: ${targetSizeMB}MB, limit: ${sizeLimitMB}MB, Video: ${(adjustedVideoBitrate/1000).toFixed(0)}kbps (${(bitrateReduction * 100).toFixed(0)}%), Audio: ${(finalAudioBitrate/1000).toFixed(0)}kbps`);

                    // Single-pass encoding (no two-pass for iterations after first)
                    const {
                        videoCodec,
                        hardwareAcceleration
                    } = await resolveVideoCodecForEncoding(
                        preset.videoCodec,
                        isHardwareAccelerationEnabled(job),
                        job
                    );
                    const inputOptions = getHardwareInputOptions(preset.videoCodec, hardwareAcceleration);
                    const shouldTrim =
                        trimStartSec != null &&
                        trimDurationSec != null &&
                        Number.isFinite(trimStartSec) &&
                        Number.isFinite(trimDurationSec) &&
                        trimDurationSec > 0;
                    const outputOptions = buildStructuredEncodingOptions(preset, {
                            targetVideoBitrate: adjustedVideoBitrate,
                            audioBitrate: finalAudioBitrate
                        }, {
                            hardwareAcceleration,
                            videoCodec
                        });

                    const presetOptions = getPresetOptionsForAcceleration(
                        [...(preset.options || []), ...(preset.extraOptions || [])],
                        hardwareAcceleration,
                        videoCodec
                    );
                    outputOptions.push(...presetOptions);
                    const onProgress = progressCallback ? (percent) => {
                                const rawPercent = percent;
                                // Update job message to include iteration information if available
                                if (job) {
                                    // Calculate time elapsed since iteration started
                                    const iterationElapsed = job.iterationStartTime ? Math.floor((Date.now() - job.iterationStartTime) / 1000) : 0;
                                    const elapsedText = formatElapsedTime(iterationElapsed);
                                    
                                    // Calculate ETA based on current progress
                                    let etaText = '';
                                    if (rawPercent > 1 && rawPercent < 99) {
                                        const estimatedTotalSeconds = (iterationElapsed / rawPercent) * 100;
                                        const remainingSeconds = Math.max(0, estimatedTotalSeconds - iterationElapsed);
                                        etaText = formatElapsedTime(Math.floor(remainingSeconds));
                                    }
                                    
                                    // Update message with iteration info, progress, and timing
                                    job.progressMessage = `Iteration ${iteration}/${maxIterations}: ${percent}%` +
                                        (job.lastIterationSize ? `\nPrevious size: ${job.lastIterationSize}MB` : '') +
                                        `\nElapsed: ${elapsedText}` +
                                        (etaText ? `\nETA: ${etaText}` : '');
                                }
                                progressCallback(percent);
                    } : null;

                    await runDirectFfmpeg(buildEncodingArgs(input, output, {
                        startTime: shouldTrim ? trimStartSec : null,
                        duration: shouldTrim ? trimDurationSec : null,
                        inputOptions,
                        videoCodec,
                        audioCodec: preset.audioCodec,
                        outputOptions
                    }), {
                        duration: currentDuration,
                        progressCallback: onProgress,
                        job,
                        label: `[Iteration ${iteration}]`
                    });
                    console.log(`[Iteration ${iteration}] Single-pass encoding completed`);

                    // Check output size against limit (not target)
                    const outputSizeMB = await getFileSizeMB(output);
                    console.log(`[Iteration ${iteration}] Output size: ${outputSizeMB.toFixed(2)}MB (limit: ${sizeLimitMB}MB, target: ${targetSizeMB}MB)`);

                    if (outputSizeMB <= sizeLimitMB || iteration >= maxIterations) {
                        if (outputSizeMB <= sizeLimitMB) {
                            console.log(`[Bitrate Adjustment] Successfully under limit of ${sizeLimitMB}MB (${outputSizeMB.toFixed(2)}MB) in ${iteration} iteration(s)`);
                            if (job) {
                                // Calculate total time taken for all iterations
                                const totalElapsed = Math.floor((Date.now() - job.iterationStartTime) / 1000);
                                const elapsedText = formatElapsedTime(totalElapsed);
                                
                                job.progressMessage = `Completed in ${iteration} iteration(s)\nFinal size: ${outputSizeMB.toFixed(2)}MB\nTotal time: ${elapsedText}`;
                            }
                        } else {
                            console.log(`[Bitrate Adjustment] Reached max iterations, final size: ${outputSizeMB.toFixed(2)}MB`);
                            if (job) {
                                // Calculate total time taken for all iterations
                                const totalElapsed = Math.floor((Date.now() - job.iterationStartTime) / 1000);
                                const elapsedText = formatElapsedTime(totalElapsed);
                                
                                job.progressMessage = `Reached max iterations (${iteration})\nFinal size: ${outputSizeMB.toFixed(2)}MB\nTotal time: ${elapsedText}`;
                            }
                        }
                        // Set progress to 100% when done with all iterations
                        if (progressCallback) progressCallback(100);
                        return;
                    }

                    // Calculate more precise reduction based on size ratio
                    const sizeRatio = outputSizeMB / sizeLimitMB;
                    // More aggressive reduction for larger files - closer to square root relationship
                    // File size is roughly proportional to bitrate, but not exactly linear due to codec efficiency
                    const targetReduction = Math.min(0.9, Math.max(0.4, Math.pow(1 / sizeRatio, 1.2))); 
                    bitrateReduction = bitrateReduction * targetReduction;
                    
                    // Update job message to indicate starting a new iteration
                    if (job) {
                        job.currentIteration = iteration + 1;
                        job.totalIterations = maxIterations;
                        job.lastIterationSize = outputSizeMB.toFixed(2);
                        job.iterationStartTime = Date.now();
                        job.progressMessage = `Starting iteration ${iteration + 1}/${maxIterations}`;
                    }
                    
                    // Reset progress to indicate new iteration starting
                    if (progressCallback) progressCallback(0);
                    console.log(`[Bitrate Adjustment] Size ${outputSizeMB.toFixed(2)}MB over limit ${sizeLimitMB}MB, reducing bitrate to ${(bitrateReduction * 100).toFixed(0)}% for next iteration`);
                }
            }

            if (config.processingStrategy === 'sizeTarget') {
                if (progressCallback) progressCallback(0);

                const inputStat = await fs.stat(inputPath);
                const inputSizeMB = inputStat.size / (1024 * 1024);
                const fullDurSec = (await probeMedia(inputPath)).format.duration;
                const estTrimmedMB =
                    fullDurSec > 0 ? inputSizeMB * Math.min(1, duration / fullDurSec) : inputSizeMB;
                console.log(
                    `[${compressionMode.toUpperCase()}] Estimated trim size: ${estTrimmedMB.toFixed(2)}MB (limit: ${config.sizeLimitMB}MB, target: ${config.targetSizeMB}MB)`
                );

                // Fits under cap: stream-copy trim only (no extra encode; start may align to keyframe).
                if (estTrimmedMB <= config.sizeLimitMB) {
                    console.log(
                        `[${compressionMode.toUpperCase()}] Estimated under limit - stream copy from original`
                    );
                    await trimStreamCopyFromOriginal(inputPath, outputPath, startTime, duration);
                    if (progressCallback) progressCallback(100);
                    resolve();
                    return;
                }

                console.log(
                    `[${compressionMode.toUpperCase()}] Over limit, compressing to ${config.targetSizeMB}MB target (single pass from original)`
                );
                await compressWithBitrateAdjustment(
                    inputPath,
                    outputPath,
                    config,
                    3,
                    job,
                    startTime,
                    duration
                );
                if (progressCallback) progressCallback(100);
                resolve();
                return;
            }

            if (config.processingStrategy === 'bitrateTarget') {
                console.log(`[${config.name}] Encoding from original (${startTime}s, ${duration}s)`);

                const { targetVideoBitrate, audioBitrate } = await calculateTargetBitrate(
                    inputPath,
                    config.targetSizePercent,
                    duration,
                    config.targetSizeMB
                );

                const outputOptions = buildStructuredEncodingOptions(config, {
                        targetVideoBitrate,
                        audioBitrate
                    }, {
                        hardwareAcceleration,
                        videoCodec
                    });

                const inputOptions = getHardwareInputOptions(config.videoCodec, hardwareAcceleration);
                const presetOptions = getPresetOptionsForAcceleration(
                    [...(config.options || []), ...(config.extraOptions || [])],
                    hardwareAcceleration,
                    videoCodec
                );
                outputOptions.push(...presetOptions);
                await runDirectFfmpeg(buildEncodingArgs(inputPath, outputPath, {
                    startTime,
                    duration,
                    inputOptions,
                    videoCodec,
                    audioCodec: config.audioCodec,
                    outputOptions
                }), { duration, progressCallback, job, label: `[${config.name}]` });
                console.log(`[${config.name}] Compression completed`);

                if (progressCallback) progressCallback(100);
                resolve();
                return;
            }

            if (config.processingStrategy === 'manual') {
                console.log(`[${config.name}] Encoding with manual rate control (${config.rateControl})`);

                const outputOptions = buildStructuredEncodingOptions(config, {}, {
                        hardwareAcceleration,
                        videoCodec
                    });

                const inputOptions = getHardwareInputOptions(config.videoCodec, hardwareAcceleration);
                const presetOptions = getPresetOptionsForAcceleration(
                    [...(config.options || []), ...(config.extraOptions || [])],
                    hardwareAcceleration,
                    videoCodec
                );
                outputOptions.push(...presetOptions);
                await runDirectFfmpeg(buildEncodingArgs(inputPath, outputPath, {
                    startTime,
                    duration,
                    inputOptions,
                    videoCodec,
                    audioCodec: config.audioCodec,
                    outputOptions
                }), { duration, progressCallback, job, label: `[${config.name}]` });
                console.log(`[${config.name}] Manual compression completed`);

                if (progressCallback) progressCallback(100);
                resolve();
                return;
            }

            // Original mode or fallback for any other modes
            console.log(`[${config.name}] Using standard processing`);
            
            const outputOptions = buildStructuredEncodingOptions(config, {}, {
                    hardwareAcceleration,
                    videoCodec
                });
            
            // Calculate target bitrate for non-original modes
            const inputOptions = getHardwareInputOptions(config.videoCodec, hardwareAcceleration);

            // Calculate target bitrate for non-original modes
            if (compressionMode !== 'original') {
                const { targetVideoBitrate, audioBitrate, compressionRatio } = await calculateTargetBitrate(
                    inputPath,
                    config.targetSizePercent,
                    duration,
                    config.targetSizeMB
                );
                
                console.log(`Expected compression ratio: ${compressionRatio}%`);
                
                const bitrateOptions = [
                    '-b:v',
                    String(targetVideoBitrate),
                    '-b:a',
                    String(audioBitrate)
                ];
                if (supportsConstrainedBitrateOptions(videoCodec)) {
                    bitrateOptions.push(
                        '-maxrate',
                        String(Math.round(targetVideoBitrate * 1.5)),
                        '-bufsize',
                        String(Math.round(targetVideoBitrate * 2))
                    );
                }
                outputOptions.push(...bitrateOptions);
            }
            
            // Add compression-specific options
            const presetOptions = getPresetOptionsForAcceleration(
                [...(config.options || []), ...(config.extraOptions || [])],
                hardwareAcceleration,
                videoCodec
            );
            outputOptions.push(...presetOptions);
            const loggedProgress = progressCallback ? (percent) => {
                progressCallback(percent);
                console.log(`FFmpeg progress: ${percent}% - ${config.name}`);
            } : null;
            await runDirectFfmpeg(buildEncodingArgs(inputPath, outputPath, {
                startTime,
                duration,
                inputOptions,
                videoCodec,
                audioCodec: config.audioCodec,
                outputOptions
            }), { duration, progressCallback: loggedProgress, job, label: `[${config.name}]` });
            console.log(`FFmpeg processing completed successfully with ${config.name}`);
            resolve();
        } catch (error) {
            reject(error);
        }
    });
}

function getPrimaryMediaInfo(inputPath) {
    return probeMedia(inputPath).then((metadata) => {
            const videoStream = metadata.streams.find((stream) => stream.codec_type === 'video');
            const audioStream = metadata.streams.find((stream) => stream.codec_type === 'audio');
            return {
                videoCodec: videoStream?.codec_name || null,
                audioCodec: audioStream?.codec_name || null,
                width: Number(videoStream?.width) || 0,
                height: Number(videoStream?.height) || 0,
                frameRate: videoStream?.avg_frame_rate || videoStream?.r_frame_rate || null,
                hasAudio: Boolean(audioStream)
            };
    });
}

function parseFrameRate(frameRate) {
    if (typeof frameRate !== 'string' || !frameRate) return 30;
    const [numeratorText, denominatorText = '1'] = frameRate.split('/');
    const numerator = Number(numeratorText);
    const denominator = Number(denominatorText);
    const parsed = denominator > 0 ? numerator / denominator : 0;
    return Number.isFinite(parsed) && parsed >= 1 && parsed <= 120 ? parsed : 30;
}

async function getConcatNormalizationProfile(inputPath, hardwareAcceleration = false, job = null) {
    const mediaInfo = await getPrimaryMediaInfo(inputPath);
    if (!mediaInfo.width || !mediaInfo.height) {
        throw new Error('Could not determine the first track video dimensions');
    }

    const encoder = await resolveVideoCodecForEncoding(
        'libx264',
        hardwareAcceleration,
        job
    );

    return {
        // yuv420p requires even dimensions. Use the first selected track as the
        // canvas and letterbox other aspect ratios into it.
        width: Math.max(2, Math.floor(mediaInfo.width / 2) * 2),
        height: Math.max(2, Math.floor(mediaInfo.height / 2) * 2),
        frameRate: parseFrameRate(mediaInfo.frameRate),
        videoCodec: encoder.videoCodec,
        hardwareAcceleration: encoder.hardwareAcceleration
    };
}

async function normalizeVideoForConcat(inputPath, outputPath, startTime, endTime, profile, progressCallback = null, job = null) {
    const duration = endTime - startTime;
    const { hasAudio } = await getPrimaryMediaInfo(inputPath);
    const frameRate = Number(profile.frameRate.toFixed(3));
    const scaleAndPad = [
        `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease`,
        `pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2:black`,
        'setsar=1',
        `fps=${frameRate}`
    ].join(',');
    const videoEncodingOptions = profile.hardwareAcceleration
        ? [
            '-c:v', profile.videoCodec,
            '-preset', 'p4',
            '-rc', 'vbr',
            '-cq', '18',
            '-b:v', '0'
        ]
        : [
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '18'
        ];

    const trimCommand = [
        '-y',
        '-nostdin',
        '-hide_banner',
        '-ss', String(startTime),
        '-t', String(duration),
        '-i', inputPath
    ];

    if (!hasAudio) {
        trimCommand.push(
            '-f', 'lavfi',
            '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'
        );
    }

    trimCommand.push(
        '-map', '0:v:0',
        '-map', hasAudio ? '0:a:0' : '1:a:0',
        '-vf', scaleAndPad,
        ...videoEncodingOptions,
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '48000',
        '-ac', '2',
        '-af', 'apad,aresample=async=1:first_pts=0',
        '-t', String(duration),
        '-shortest',
        '-avoid_negative_ts', 'make_zero',
        '-reset_timestamps', '1',
        '-f', 'mpegts',
        outputPath
    );

    if (progressCallback) {
        progressCallback(0);
    }

    return new Promise((resolve, reject) => {
        console.log(`FFmpeg concat normalization command: ffmpeg ${trimCommand.join(' ')}`);
        const ffmpegProcess = spawn('ffmpeg', trimCommand, {
            stdio: ['ignore', 'ignore', 'pipe']
        });

        if (job) {
            job.ffmpegProcess = ffmpegProcess;
        }

        let stderrOutput = '';

        ffmpegProcess.stderr.on('data', (data) => {
            stderrOutput += data.toString();
            if (stderrOutput.length > 12000) {
                stderrOutput = stderrOutput.slice(-12000);
            }
        });

        ffmpegProcess.on('close', (code) => {
            if (job) job.ffmpegProcess = null;
            if (code === 0) {
                if (progressCallback) progressCallback(100);
                resolve({ audioCodec: 'aac' });
            } else {
                console.error(`FFmpeg concat normalization stderr: ${stderrOutput}`);
                reject(new Error(`FFmpeg concat normalization exited with code ${code}`));
            }
        });

        ffmpegProcess.on('error', (err) => {
            if (job) job.ffmpegProcess = null;
            reject(err);
        });
    });
}

async function combineVideoTracks(tracks, outputPath, compressionMode, progressCallback = null, job = null) {
    try {
        // Create a temporary file for the combined video
        const tempCombinedPath = path.join(TEMP_DIR, `combined_${Date.now()}.mp4`);
        
        // Create a file list for ffmpeg
        const fileListPath = path.join(TEMP_DIR, `filelist_${Date.now()}.txt`);
        const formatConcatPath = (filePath) => filePath.replace(/\\/g, '/').replace(/'/g, "'\\''");
        const fileList = tracks.map(track => `file '${formatConcatPath(track.path)}'`).join('\n');
        await fs.writeFile(fileListPath, fileList);

        // Combine videos using ffmpeg
        const combineCommand = [
            '-y',
            '-nostdin',
            '-hide_banner',
            '-fflags', '+genpts',
            '-f', 'concat',
            '-safe', '0',
            '-i', fileListPath,
            '-c', 'copy',
            '-avoid_negative_ts', 'make_zero',
            tempCombinedPath
        ];

        if (tracks.some((track) => track.audioCodec === 'aac')) {
            combineCommand.splice(combineCommand.length - 1, 0, '-bsf:a', 'aac_adtstoasc');
        }

        // Report initial combining progress
        if (progressCallback) {
            progressCallback(0);
        }

        await new Promise((resolve, reject) => {
            console.log(`FFmpeg combine command: ffmpeg ${combineCommand.join(' ')}`);
            const ffmpegProcess = spawn('ffmpeg', combineCommand, {
                stdio: ['ignore', 'ignore', 'pipe']
            });
            
            // Store process reference for cancellation
            if (job) {
                job.ffmpegProcess = ffmpegProcess;
            }
            
            let hasReportedProgress = false;
            let stderrOutput = '';

            ffmpegProcess.stderr.on('data', (data) => {
                stderrOutput += data.toString();
                if (stderrOutput.length > 12000) {
                    stderrOutput = stderrOutput.slice(-12000);
                }
            });
            
            // Report progress during combining (simple step progress since we can't get detailed progress from concat)
            const progressInterval = setInterval(() => {
                if (!hasReportedProgress && progressCallback) {
                    progressCallback(50); // Report halfway progress during combining
                    hasReportedProgress = true;
                }
            }, 500);
            
            ffmpegProcess.on('close', (code) => {
                clearInterval(progressInterval);
                if (job) job.ffmpegProcess = null;
                if (code === 0) {
                    // Don't report 50% here - let compression start from where combining left off
                    resolve();
                } else {
                    console.error(`FFmpeg combine stderr: ${stderrOutput}`);
                    reject(new Error(`FFmpeg combine process exited with code ${code}`));
                }
            });
            ffmpegProcess.on('error', (err) => {
                clearInterval(progressInterval);
                if (job) job.ffmpegProcess = null;
                reject(err);
            });
        });

        // Clean up file list
        await fs.unlink(fileListPath);

        if (compressionMode !== 'original') {
            // Probe the combined file for its duration
            const duration = (await probeMedia(tempCombinedPath)).format.duration;
            // Compress the entire combined file
            // Create wrapper callback that maps compression progress (0-100%) to full range (0-100%)
            const compressionCallback = progressCallback ? (compressionProgress) => {
                progressCallback(compressionProgress);
            } : null;
            
            await trimVideoWithCompression(tempCombinedPath, outputPath, 0, duration, compressionMode, compressionCallback, job);
            // Clean up temp file
            await fs.unlink(tempCombinedPath);
        } else {
            // If no compression, just move the combined file to output
            await fsSync.renameSync(tempCombinedPath, outputPath);
            // Report completion
            if (progressCallback) {
                progressCallback(100);
            }
        }

        return true;
    } catch (error) {
        console.error('Error combining videos:', error);
        throw error;
    }
}

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Express error:', error);
    
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'File exceeds the 10 GB maximum size.' });
        }
        return res.status(400).json({ error: error.message });
    }

    if (error?.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
    }
    
    res.status(500).json({ 
        error: 'Internal server error',
        message: error.message 
    });
});

// Start server
async function startServer() {
    try {
        await ensureDirectories();
        
        app.listen(PORT, HOST, () => {
            console.log('Video Trimmer Server with Compression Modes');
            console.log('========================================================');
            console.log(`Server running on: http://${HOST}:${PORT}`);
            console.log(`Health check: http://${HOST}:${PORT}/health`);
            console.log('========================================================');
            console.log('Ready to process videos with compression!');
            console.log(`Available compression modes: ${Object.keys(COMPRESSION_MODES).length}`);
            console.log('ALL video processing is asynchronous');
            console.log('Automatic cleanup every 30 minutes');
            if (!process.env.VIDEO_TRIMMER_AUTH_TOKEN) {
                console.log(`Development API token: ${API_TOKEN}`);
            }
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down server...');
    
    try {
        // Final cleanup
        await cleanupOldFiles();
        console.log('Final cleanup completed');
    } catch (error) {
        console.warn('Final cleanup warning:', error.message);
    }
    
    console.log('Server stopped gracefully');
    process.exit(0);
});

// Handle other termination signals
process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    
    try {
        await cleanupOldFiles();
        console.log('Final cleanup completed');
    } catch (error) {
        console.warn('Final cleanup warning:', error.message);
    }
    
    process.exit(0);
});

startServer();  
