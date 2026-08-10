export type UploadQueueStatus = 'pending' | 'uploading' | 'completed' | 'skipped' | 'failed';

export type UploadQueueItem = {
  file: File | null;
  filePath: string | null;
  trackId: string;
  status: UploadQueueStatus;
  progress: number;
  videoId: string | null;
  error: string | null;
};

export type VideoTrack = {
  id: string;
  videoFile: File | null;
  filePath: string | null;
  fileSizeBytes?: number | null;
  startTime: string;
  endTime: string;
  offset: number;
  volume: number;
  compressionMode: string;
  uploadedVideoId: string | null;
  endTimeManuallySet: boolean;
  selected: boolean;
  duration: number;
};

export type CompressionPreset = {
  id: string;
  name: string;
  description: string;
  processingStrategy: 'directCopy' | 'bitrateTarget' | 'sizeTarget' | 'manual';
  rateControl?: 'targetPercent' | 'targetSize' | 'constantBitrate' | 'constantQuality' | 'constantQp';
  videoCodec?: string;
  audioCodec?: string;
  options?: string[];
  extraOptions?: string[];
  targetSizePercent: number | null;
  targetSizeMB: number | null;
  sizeLimitMB: number | null;
  sizeLabel: string | null;
  bitrateKbps?: number | null;
  maxrateKbps?: number | null;
  bufsizeKbps?: number | null;
  audioBitrateKbps?: number | null;
  crf?: number | null;
  qp?: number | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  encoderPreset?: string | null;
  profile?: string | null;
  level?: string | null;
  tune?: string | null;
  pixelFormat?: string | null;
  audioSampleRate?: number | null;
  audioChannels?: number | null;
  estimatedTime?: string;
  qualityLevel?: string;
  builtIn?: boolean;
};

export type LibraryClipState = {
  startTime?: string;
  endTime?: string;
  compressionMode?: string;
  volume?: number;
  endTimeManuallySet?: boolean;
};

