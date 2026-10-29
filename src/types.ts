export type StreamProtocol = 'HLS_MASTER' | 'HLS_MEDIA' | 'DIRECT_MP4' | 'DIRECT_WEBM' | 'JS_EMBEDDED';

export interface StreamVariant {
  id: string;
  url: string;
  protocol: StreamProtocol;
  label: string;
  folderName?: string;
  lectureTitle?: string;
  facultyName?: string;
  date?: string;
  pdfUrl?: string;
  resolution?: string;
  bandwidth?: number;
  codecs?: string;
  frameRate?: number;
  segmentCount?: number;
  durationSec?: number;
  estimatedSizeBytes?: number;
  isEncrypted?: boolean;
  encryptionMethod?: string;
  foundVia: string;
}

export interface ExtractionResult {
  sourceUrl: string;
  pageTitle: string;
  extractedAt: string;
  streams: StreamVariant[];
  folders: string[];
  scriptsScanned: number;
  rawManifestSnippet?: string;
  notes: string[];
}

export type DeliveryMode = 'browser' | 'telegram_auto' | 'telegram_userbot';

export type JobStatus =
  | 'queued'
  | 'downloading'
  | 'merging'
  | 'uploading_bot_api'
  | 'uploading_mtproto_userbot'
  | 'completed'
  | 'failed';

export interface DownloadJob {
  id: string;
  title: string;
  folderName?: string;
  sourceUrl: string;
  protocol: StreamProtocol;
  preferredQuality?: string;
  resolution?: string;
  status: JobStatus;
  progressPercent: number;
  totalSegments: number;
  completedSegments: number;
  downloadedBytes: number;
  speedBytesPerSec: number;
  deliveryMode: DeliveryMode;
  telegramChatId?: string;
  telegramResult?: {
    deliveredVia: 'BOT_API_50MB' | 'MTPROTO_USERBOT_2GB';
    chatId: string;
    fileSizeMb: string;
    timestamp: string;
    backedUpTo?: string[];
    routedToChannel?: string;
  };
  outputFormat: 'mp4' | 'ts';
  error?: string;
  createdAt: string;
  fileReadyForBrowser: boolean;
}

export interface BotActivityLog {
  id: string;
  timestamp: string;
  direction: 'INCOMING' | 'OUTGOING' | 'USERBOT_MTPROTO' | 'SYSTEM';
  chatId: string;
  summary: string;
}

export type AccessDurationKey = '24h' | '48h' | '7d' | '30d';
export type VideoQualityOption = '144p' | '240p' | '360p' | '480p' | '720p' | '1080p';

export interface AccessCodeState {
  code: string;
  durationKey: AccessDurationKey;
  durationLabel: string;
  durationMs: number;
  createdAt: string;
  expiresAt: string;
}

export interface AuthorizedUserSession {
  chatId: string;
  name?: string;
  firstName?: string;
  username?: string;
  activatedWithCode: string;
  activatedAt: string;
  expiresAt: string;
}

export interface BackupChannelConfig {
  id: string;
  chatId: string;
  title: string;
  type: 'channel' | 'group';
  enabled: boolean;
  addedVia: 'web' | 'bot';
  addedAt: string;
}

export interface ChannelRouteRule {
  id: string;
  pattern: string;
  label: string;
  targetChatId: string;
  targetTitle: string;
  enabled: boolean;
  createdAt: string;
}

export interface HuggingFaceCloudStatus {
  isRunningOnHuggingFace: boolean;
  deployedRepoId?: string;
  deployedSpaceUrl?: string;
  deployedAppUrl?: string;
  githubRepoUrl?: string;
  renderDeployUrl?: string;
  lastDeployedAt?: string;
  autoPingEnabled: boolean;
  localPollingPaused: boolean;
}

export interface BotSecuritySettings {
  globalDefaultQuality: VideoQualityOption;
  preferFullSingleVideo: boolean;
  accessCode: AccessCodeState;
  authorizedUsers: AuthorizedUserSession[];
  backupChannels: BackupChannelConfig[];
  routeRules: ChannelRouteRule[];
  hfCloud?: HuggingFaceCloudStatus;
}

export interface TelegramConfigStatus {
  botApi: {
    hasToken: boolean;
    connected: boolean;
    username?: string;
    firstName?: string;
    maxSizeMb: number;
    pollingActive: boolean;
    error?: string;
  };
  userbotMtproto: {
    hasApiId: boolean;
    hasApiHash: boolean;
    hasStringSession: boolean;
    connected: boolean;
    accountName?: string;
    username?: string;
    maxSizeMb: number;
    error?: string;
  };
  defaultChatId: string;
  ffmpegAvailable: boolean;
  logs: BotActivityLog[];
  security?: BotSecuritySettings;
}

