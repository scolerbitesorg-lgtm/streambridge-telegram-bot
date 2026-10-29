import express from 'express';
import { createServer as createViteServer } from 'vite';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { CustomFile } from 'telegram/client/uploads.js';

dotenv.config();

const execFileAsync = promisify(execFile);

const DOWNLOAD_DIR = path.join(os.tmpdir(), 'streambridge-downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
} else {
  try {
    for (const file of fs.readdirSync(DOWNLOAD_DIR)) {
      try {
        fs.unlinkSync(path.join(DOWNLOAD_DIR, file));
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

function cleanupJobTempFiles(jobId: string) {
  try {
    if (!fs.existsSync(DOWNLOAD_DIR)) return;
    for (const file of fs.readdirSync(DOWNLOAD_DIR)) {
      if (file.startsWith(`${jobId}_`)) {
        try {
          fs.unlinkSync(path.join(DOWNLOAD_DIR, file));
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
}

type AccessDurationKey = '24h' | '48h' | '7d' | '30d';
type VideoQualityOption = '144p' | '240p' | '360p' | '480p' | '720p' | '1080p';

interface AccessCodeState {
  code: string;
  durationKey: AccessDurationKey;
  durationLabel: string;
  durationMs: number;
  createdAt: string;
  expiresAt: string;
}

interface AuthorizedUserSession {
  chatId: string;
  name?: string;
  firstName?: string;
  username?: string;
  activatedWithCode: string;
  activatedAt: string;
  expiresAt: string;
}

interface BackupChannelConfig {
  id: string;
  chatId: string;
  title: string;
  type: 'channel' | 'group';
  enabled: boolean;
  addedVia: 'web' | 'bot';
  addedAt: string;
}

interface ChannelRouteRule {
  id: string;
  pattern: string;
  label: string;
  targetChatId: string;
  targetTitle: string;
  enabled: boolean;
  createdAt: string;
}

interface HuggingFaceCloudConfig {
  deployedRepoId?: string;
  deployedSpaceUrl?: string;
  deployedAppUrl?: string;
  lastDeployedAt?: string;
  autoPingEnabled: boolean;
  localPollingPaused: boolean;
}

interface PersistedBotSettings {
  globalDefaultQuality: VideoQualityOption;
  preferFullSingleVideo: boolean;
  accessCode: AccessCodeState;
  authorizedUsers: Record<string, AuthorizedUserSession>;
  backupChannels: BackupChannelConfig[];
  routeRules: ChannelRouteRule[];
  hfCloud: HuggingFaceCloudConfig;
}

const IS_RUNNING_ON_HF = Boolean(process.env.SPACE_ID || process.env.SPACE_AUTHOR_NAME);

const DURATION_MAP: Record<AccessDurationKey, { label: string; ms: number }> = {
  '24h': { label: '24 Hours (Daily)', ms: 24 * 60 * 60 * 1000 },
  '48h': { label: '48 Hours (2 Days)', ms: 48 * 60 * 60 * 1000 },
  '7d': { label: '7 Days (Weekly)', ms: 7 * 24 * 60 * 60 * 1000 },
  '30d': { label: '30 Days (Monthly)', ms: 30 * 24 * 60 * 60 * 1000 },
};

const BOT_CONFIG_PATH = path.join(process.cwd(), 'bot-config.json');

function generateRandomCodeString(): string {
  const digits = Math.floor(1000 + Math.random() * 9000);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 3; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `SB-${digits}-${suffix}`;
}

function createFreshAccessCode(durationKey: AccessDurationKey = '24h'): AccessCodeState {
  const dur = DURATION_MAP[durationKey] || DURATION_MAP['24h'];
  const now = Date.now();
  return {
    code: generateRandomCodeString(),
    durationKey,
    durationLabel: dur.label,
    durationMs: dur.ms,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + dur.ms).toISOString(),
  };
}

let botSettings: PersistedBotSettings = {
  globalDefaultQuality: '720p',
  preferFullSingleVideo: true,
  accessCode: createFreshAccessCode('24h'),
  authorizedUsers: {},
  backupChannels: [],
  routeRules: [],
  hfCloud: {
    autoPingEnabled: true,
    localPollingPaused: false,
  },
};

function saveBotSettings() {
  try {
    fs.writeFileSync(BOT_CONFIG_PATH, JSON.stringify(botSettings, null, 2), 'utf8');
  } catch {
    // ignore
  }
}

function loadBotSettings() {
  try {
    if (fs.existsSync(BOT_CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(BOT_CONFIG_PATH, 'utf8')) as Partial<PersistedBotSettings>;
      if (parsed.globalDefaultQuality) {
        botSettings.globalDefaultQuality = parsed.globalDefaultQuality;
      }
      if (typeof parsed.preferFullSingleVideo === 'boolean') {
        botSettings.preferFullSingleVideo = parsed.preferFullSingleVideo;
      }
      if (parsed.accessCode && parsed.accessCode.code && parsed.accessCode.expiresAt) {
        botSettings.accessCode = parsed.accessCode;
      }
      if (parsed.authorizedUsers && typeof parsed.authorizedUsers === 'object') {
        botSettings.authorizedUsers = parsed.authorizedUsers;
      }
      if (Array.isArray(parsed.backupChannels)) {
        botSettings.backupChannels = parsed.backupChannels;
      }
      if (Array.isArray(parsed.routeRules)) {
        botSettings.routeRules = parsed.routeRules;
      }
      if (parsed.hfCloud && typeof parsed.hfCloud === 'object') {
        botSettings.hfCloud = {
          ...botSettings.hfCloud,
          ...parsed.hfCloud,
        };
      }
    }
  } catch {
    // ignore
  }
  if (IS_RUNNING_ON_HF) {
    botSettings.hfCloud.localPollingPaused = false;
  }
  saveBotSettings();
}
loadBotSettings();

function upsertBackupChannel(
  chatId: string,
  title: string,
  type: 'channel' | 'group' = 'channel',
  addedVia: 'web' | 'bot' = 'bot'
): BackupChannelConfig {
  const cleanId = chatId.trim();
  const existing = botSettings.backupChannels.find(
    (c) => c.chatId.toLowerCase() === cleanId.toLowerCase()
  );
  if (existing) {
    if (title && title.trim()) existing.title = title.trim();
    existing.enabled = true;
    saveBotSettings();
    return existing;
  }
  const created: BackupChannelConfig = {
    id: crypto.randomUUID(),
    chatId: cleanId,
    title: (title || cleanId).trim(),
    type,
    enabled: true,
    addedVia,
    addedAt: new Date().toISOString(),
  };
  botSettings.backupChannels.push(created);
  saveBotSettings();
  return created;
}

function findMatchingRouteRule(targetUrl?: string): ChannelRouteRule | undefined {
  if (!targetUrl) return undefined;
  const lowerUrl = targetUrl.toLowerCase().trim();
  for (const rule of botSettings.routeRules) {
    if (!rule.enabled || !rule.pattern.trim() || !rule.targetChatId.trim()) continue;
    const pat = rule.pattern.toLowerCase().trim();
    if (lowerUrl.includes(pat)) {
      return rule;
    }
  }
  return undefined;
}

function ensureValidAccessCode(): AccessCodeState {
  const now = Date.now();
  const exp = new Date(botSettings.accessCode.expiresAt).getTime();
  if (isNaN(exp) || exp <= now) {
    botSettings.accessCode = createFreshAccessCode(botSettings.accessCode.durationKey || '24h');
    saveBotSettings();
  }
  let changed = false;
  for (const [cid, session] of Object.entries(botSettings.authorizedUsers)) {
    if (new Date(session.expiresAt).getTime() <= now) {
      delete botSettings.authorizedUsers[cid];
      changed = true;
    }
  }
  if (changed) saveBotSettings();
  return botSettings.accessCode;
}

function isChatAuthorized(chatId: string): boolean {
  ensureValidAccessCode();
  const ownerId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (ownerId && String(chatId).trim() === ownerId) {
    return true;
  }
  const session = botSettings.authorizedUsers[chatId];
  if (!session) return false;
  return new Date(session.expiresAt).getTime() > Date.now();
}

interface StreamVariant {
  id: string;
  url: string;
  protocol: 'HLS_MASTER' | 'HLS_MEDIA' | 'DIRECT_MP4' | 'DIRECT_WEBM' | 'JS_EMBEDDED';
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

interface DownloadJob {
  id: string;
  title: string;
  folderName?: string;
  sourceUrl: string;
  originalRequestUrl?: string;
  explicitTargetChannelId?: string;
  protocol: StreamVariant['protocol'];
  preferredQuality?: string;
  resolution?: string;
  status:
    | 'queued'
    | 'downloading'
    | 'merging'
    | 'uploading_bot_api'
    | 'uploading_mtproto_userbot'
    | 'completed'
    | 'failed';
  progressPercent: number;
  totalSegments: number;
  completedSegments: number;
  downloadedBytes: number;
  speedBytesPerSec: number;
  deliveryMode: 'browser' | 'telegram_auto' | 'telegram_userbot';
  telegramChatId?: string;
  telegramStatusMsgId?: number;
  telegramResult?: {
    deliveredVia: 'BOT_API_50MB' | 'MTPROTO_USERBOT_2GB';
    chatId: string;
    fileSizeMb: string;
    timestamp: string;
    backedUpTo?: string[];
    routedToChannel?: string;
  };
  outputFormat: 'mp4' | 'ts';
  filePath?: string;
  error?: string;
  createdAt: string;
  fileReadyForBrowser: boolean;
  customHeaders?: Record<string, string>;
  cleanupAfterTelegram?: boolean;
}

interface BotActivityLog {
  id: string;
  timestamp: string;
  direction: 'INCOMING' | 'OUTGOING' | 'USERBOT_MTPROTO' | 'SYSTEM';
  chatId: string;
  summary: string;
}

const jobs = new Map<string, DownloadJob>();
const botLogs: BotActivityLog[] = [];

const chatJobQueues = new Map<string, DownloadJob[]>();
const activeChatWorkers = new Set<string>();

const pendingUserbotRelays = new Map<
  string,
  {
    allTargetChatIds: string[];
    cleanCaption: string;
    resolve: (deliveredMsgInfo?: { fromChatId: string; messageId: number }) => void;
  }
>();

function addBotLog(direction: BotActivityLog['direction'], chatId: string, summary: string) {
  botLogs.unshift({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    direction,
    chatId: String(chatId || 'system'),
    summary,
  });
  if (botLogs.length > 80) {
    botLogs.pop();
  }
}

let ffmpegAvailable = false;
async function checkFfmpeg() {
  try {
    await execFileAsync('ffmpeg', ['-version']);
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
}
checkFfmpeg();

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function buildHeaders(customHeaders?: Record<string, string>, refererUrl?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (refererUrl) {
    try {
      const u = new URL(refererUrl);
      headers['Referer'] = `${u.protocol}//${u.host}/`;
      headers['Origin'] = `${u.protocol}//${u.host}`;
    } catch {
      // ignore
    }
  }
  if (customHeaders) {
    for (const [k, v] of Object.entries(customHeaders)) {
      if (k && v && v.trim()) {
        headers[k.trim()] = v.trim();
      }
    }
  }
  return headers;
}

// ============================================================================
// BULLETPROOF HTTP FETCHER (NODE FETCH + NATIVE CURL FALLBACK — ZERO "fetch failed")
// ============================================================================

async function robustFetchBuffer(
  url: string,
  headers: Record<string, string>,
  maxRetries = 5
): Promise<Buffer> {
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 18000);
      const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastError = err;
      // On attempt >= 2, use native C libcurl which never suffers from Node undici socket pool resets
      if (attempt >= 2) {
        try {
          const curlArgs = ['-sL', '--fail', '--retry', '2', '--max-time', '20'];
          for (const [k, v] of Object.entries(headers)) {
            curlArgs.push('-H', `${k}: ${v}`);
          }
          curlArgs.push(url);
          const { stdout } = await execFileAsync('curl', curlArgs, {
            encoding: 'buffer',
            maxBuffer: 60 * 1024 * 1024,
          });
          if (stdout && stdout.length > 0) {
            return stdout;
          }
        } catch (curlErr) {
          lastError = curlErr;
        }
      }
      await new Promise((r) => setTimeout(r, 350 * attempt));
    }
  }

  throw lastError || new Error(`Failed to fetch ${url}`);
}

async function robustFetchText(
  url: string,
  headers: Record<string, string>,
  maxRetries = 4
): Promise<{ text: string; finalUrl: string; contentType: string }> {
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const text = await res.text();
      return {
        text,
        finalUrl: res.url || url,
        contentType: (res.headers.get('content-type') || '').toLowerCase(),
      };
    } catch (err) {
      lastError = err;
      try {
        const curlArgs = ['-sL', '--fail', '--retry', '2', '--max-time', '18'];
        for (const [k, v] of Object.entries(headers)) {
          curlArgs.push('-H', `${k}: ${v}`);
        }
        curlArgs.push(url);
        const { stdout } = await execFileAsync('curl', curlArgs, {
          encoding: 'utf8',
          maxBuffer: 25 * 1024 * 1024,
        });
        return {
          text: stdout,
          finalUrl: url,
          contentType: stdout.trim().startsWith('#EXTM3U') ? 'application/vnd.apple.mpegurl' : 'text/html',
        };
      } catch (curlErr) {
        lastError = curlErr;
      }
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }

  throw lastError || new Error(`Could not fetch text from ${url}`);
}

function resolveRelativeUrl(relOrAbs: string, baseUrl: string): string {
  try {
    return new URL(relOrAbs.trim(), baseUrl).toString();
  } catch {
    return relOrAbs.trim();
  }
}

function isUrlPathnameEndingWith(rawUrl: string, regex: RegExp): boolean {
  try {
    const u = new URL(rawUrl);
    return regex.test(u.pathname);
  } catch {
    return regex.test(rawUrl.split('?')[0]);
  }
}

function unwrapQueryRedirectUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (/\/api\/proxy/i.test(u.pathname)) {
      return null;
    }
    for (const param of ['url', 'src', 'm3u8', 'stream', 'video', 'file', 'link']) {
      const val = u.searchParams.get(param);
      if (val && /^https?:\/\//i.test(val.trim())) {
        const inner = val.trim();
        if (/classx\.co\.in/i.test(inner)) {
          return `https://studybeepro.site/api/proxy?url=${encodeURIComponent(inner)}`;
        }
        return inner;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// ============================================================================
// APPX / STUDYBEEPRO / TEACHX DECRYPTION & MULTI-FOLDER TOPIC CRAWLER
// ============================================================================

function decryptAppxUrl(enc: string): string | null {
  try {
    if (!enc || typeof enc !== 'string' || !enc.includes(':')) return null;
    const [cipherB64, ivB64] = enc.split(':');
    if (!cipherB64 || !ivB64) return null;
    const key = Buffer.from('638udh3829162018', 'utf8');
    const iv = Buffer.from(ivB64, 'base64');
    const encrypted = Buffer.from(cipherB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8').trim();
  } catch {
    return null;
  }
}

async function fetchAppxDomainConfig(
  domainId: string = 'RWA',
  origin: string = 'https://studybeepro.site'
): Promise<{ apiUrl: string; token: string; name: string }> {
  const urlsToTry = [
    `https://rwa.smexfot.workers.dev/?app=${encodeURIComponent(domainId)}`,
    `${origin}/api/rwa?app=${encodeURIComponent(domainId)}&i=1`,
  ];
  for (const u of urlsToTry) {
    try {
      const res = await fetch(u, { headers: { 'User-Agent': DEFAULT_USER_AGENT } });
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data && data.domain && data.token) {
          let apiUrl = String(data.domain).trim();
          if (!apiUrl.startsWith('http')) apiUrl = `https://${apiUrl}`;
          apiUrl = apiUrl.replace(/\/$/, '');
          return {
            apiUrl,
            token: String(data.token).trim(),
            name: data.name || domainId,
          };
        }
      }
    } catch {
      // try next
    }
  }
  throw new Error(`Could not load AppX configuration for domainId=${domainId}`);
}

async function resolveAppxVideoStreamUrl(
  domainId: string,
  courseId: string,
  videoId: string,
  preferredQuality: string = '720p',
  origin: string = 'https://studybeepro.site'
): Promise<{ streamUrl: string; quality: string; title?: string }> {
  const cfg = await fetchAppxDomainConfig(domainId, origin);
  let videoData: any = null;

  try {
    const res1 = await fetch(
      `https://asmultiverse.site/rwa/?course_id=${encodeURIComponent(
        courseId
      )}&video_id=${encodeURIComponent(videoId)}&ytflag=0&folder_wise_course=0&lc_app_api_url=`,
      { headers: { 'User-Agent': DEFAULT_USER_AGENT } }
    );
    if (res1.ok) {
      const j1 = (await res1.json()) as any;
      if (j1 && j1.data) videoData = j1.data;
    }
  } catch {
    // fallback below
  }

  if (!videoData) {
    const res2 = await fetch(
      `${cfg.apiUrl}/?course_id=${encodeURIComponent(courseId)}&video_id=${encodeURIComponent(
        videoId
      )}&ytflag=0&folder_wise_course=0&lc_app_api_url=`,
      {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          'Auth-Key': 'appxapi',
          'User-ID': '32069',
          Authorization: cfg.token,
          source: 'website',
          'Client-Service': 'Appx',
        },
      }
    );
    if (res2.ok) {
      const j2 = (await res2.json()) as any;
      if (j2 && j2.data) videoData = j2.data;
    }
  }

  if (!videoData) {
    throw new Error(`Video details not found for video_id=${videoId}`);
  }

  const links: { quality?: string; path?: string }[] = Array.isArray(videoData.download_links)
    ? videoData.download_links
    : [];

  if (links.length === 0) {
    if (videoData.video_player_url && videoData.video_player_token) {
      const fallbackUrl =
        String(videoData.video_player_url).replace('?isMobile=true&', '?') +
        String(videoData.video_player_token);
      return {
        streamUrl: fallbackUrl,
        quality: '720p',
        title: videoData.Title || undefined,
      };
    }
    throw new Error(`No download_links available for video_id=${videoId}`);
  }

  // Default quality selection before playback: 720p (as requested by user)
  const targetNum = parseInt((preferredQuality || '720p').replace(/\D/g, ''), 10) || 720;
  let chosenLink = links[0];
  let bestDiff = Infinity;

  for (const link of links) {
    const qNum = parseInt(String(link.quality || '').replace(/\D/g, ''), 10);
    if (!isNaN(qNum) && link.path) {
      const diff = Math.abs(qNum - targetNum);
      if (diff < bestDiff) {
        bestDiff = diff;
        chosenLink = link;
      }
    }
  }

  const decrypted = decryptAppxUrl(chosenLink.path || '');
  if (!decrypted) {
    throw new Error(`Failed to decrypt stream path for video_id=${videoId}`);
  }

  const finalStreamUrl = /classx\.co\.in/i.test(decrypted)
    ? `${origin}/api/proxy?url=${encodeURIComponent(decrypted)}`
    : decrypted;

  return {
    streamUrl: finalStreamUrl,
    quality: chosenLink.quality || '720p',
    title: videoData.Title || undefined,
  };
}

interface ParsedMediaPlaylist {
  isMaster: false;
  segments: { url: string; duration: number; key?: { method: string; uri?: string; iv?: string } }[];
  initMapUrl?: string;
  totalDurationSec: number;
  isEncrypted: boolean;
  encryptionMethod?: string;
}

interface ParsedMasterPlaylist {
  isMaster: true;
  variants: {
    url: string;
    bandwidth?: number;
    resolution?: string;
    codecs?: string;
    frameRate?: number;
    name?: string;
  }[];
}

function parseM3u8Content(content: string, manifestUrl: string): ParsedMasterPlaylist | ParsedMediaPlaylist {
  const lines = content
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));

  if (isMaster) {
    const variants: ParsedMasterPlaylist['variants'] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = line.slice('#EXT-X-STREAM-INF:'.length);
        const bwMatch = attrs.match(/BANDWIDTH=(\d+)/i);
        const resMatch = attrs.match(/RESOLUTION=(\d+x\d+)/i);
        const codecsMatch = attrs.match(/CODECS="([^"]+)"/i);
        const fpsMatch = attrs.match(/FRAME-RATE=([\d.]+)/i);
        const nameMatch = attrs.match(/NAME="([^"]+)"/i);
        const videoMatch = attrs.match(/VIDEO="([^"]+)"/i);

        let nextIdx = i + 1;
        while (nextIdx < lines.length && lines[nextIdx].startsWith('#')) {
          nextIdx++;
        }
        if (nextIdx < lines.length) {
          variants.push({
            url: resolveRelativeUrl(lines[nextIdx], manifestUrl),
            bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : undefined,
            resolution: resMatch ? resMatch[1] : undefined,
            codecs: codecsMatch ? codecsMatch[1] : undefined,
            frameRate: fpsMatch ? parseFloat(fpsMatch[1]) : undefined,
            name: nameMatch ? nameMatch[1] : videoMatch ? videoMatch[1] : undefined,
          });
          i = nextIdx;
        }
      }
    }
    variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    return { isMaster: true, variants };
  }

  const segments: ParsedMediaPlaylist['segments'] = [];
  let currentDuration = 0;
  let totalDurationSec = 0;
  let currentKey: { method: string; uri?: string; iv?: string } | undefined;
  let isEncrypted = false;
  let encryptionMethod: string | undefined;
  let initMapUrl: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = line.slice('#EXT-X-KEY:'.length);
      const methodMatch = attrs.match(/METHOD=([^,\s]+)/i);
      const uriMatch = attrs.match(/URI="([^"]+)"/i);
      const ivMatch = attrs.match(/IV=([^,\s]+)/i);
      const method = methodMatch ? methodMatch[1].toUpperCase() : 'NONE';
      if (method !== 'NONE') {
        isEncrypted = true;
        encryptionMethod = method;
        currentKey = {
          method,
          uri: uriMatch ? resolveRelativeUrl(uriMatch[1], manifestUrl) : undefined,
          iv: ivMatch ? ivMatch[1] : undefined,
        };
      } else {
        currentKey = undefined;
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const uriMatch = line.match(/URI="([^"]+)"/i);
      if (uriMatch) {
        initMapUrl = resolveRelativeUrl(uriMatch[1], manifestUrl);
      }
    } else if (line.startsWith('#EXTINF:')) {
      const durMatch = line.slice('#EXTINF:'.length).match(/^([\d.]+)/);
      currentDuration = durMatch ? parseFloat(durMatch[1]) : 4.0;
    } else if (!line.startsWith('#')) {
      segments.push({
        url: resolveRelativeUrl(line, manifestUrl),
        duration: currentDuration || 4.0,
        key: currentKey ? { ...currentKey } : undefined,
      });
      totalDurationSec += currentDuration || 4.0;
      currentDuration = 0;
    }
  }

  return {
    isMaster: false,
    segments,
    initMapUrl,
    totalDurationSec: Math.round(totalDurationSec),
    isEncrypted,
    encryptionMethod,
  };
}

function chooseVariantByPreferredQuality(
  variants: ParsedMasterPlaylist['variants'],
  preferredQuality: string = '720p'
): ParsedMasterPlaylist['variants'][0] {
  if (variants.length === 0) {
    throw new Error('No HLS variants available in master playlist.');
  }
  if (preferredQuality === 'best') {
    return variants[0];
  }
  const targetHeight = parseInt((preferredQuality || '720p').replace(/\D/g, ''), 10) || 720;

  let bestMatch = variants[0];
  let smallestDiff = Infinity;
  for (const v of variants) {
    const heightMatch = v.resolution?.match(/x(\d+)/i);
    const nameMatch = v.name?.match(/(\d+)p/i);
    const h = heightMatch
      ? parseInt(heightMatch[1], 10)
      : nameMatch
      ? parseInt(nameMatch[1], 10)
      : 0;
    if (h > 0) {
      const diff = Math.abs(h - targetHeight);
      if (diff < smallestDiff) {
        smallestDiff = diff;
        bestMatch = v;
      }
    }
  }
  return bestMatch;
}

function extractStreamsFromJsOrText(
  text: string,
  baseUrl: string,
  foundViaLabel: string,
  discoveredMap: Map<string, { url: string; foundVia: string; folderName?: string }>,
  folderName?: string
) {
  const normalized = text.replace(/\\\//g, '/');

  const absoluteRegex = /https?:\/\/[^\s"'<>\\`]+?\.(?:m3u8|mp4|webm)(?:\?[^\s"'<>\\`]*)?/gi;
  let match: RegExpExecArray | null;
  while ((match = absoluteRegex.exec(normalized)) !== null) {
    const cleanUrl = match[0].replace(/[),;]+$/, '');
    if (!discoveredMap.has(cleanUrl)) {
      discoveredMap.set(cleanUrl, { url: cleanUrl, foundVia: foundViaLabel, folderName });
    }
  }

  const relativeRegex = /["']((?:\/|[a-zA-Z0-9_\-./]+)\.(?:m3u8|mp4|webm)(?:\?[^"'\s<>\\]*)?)["']/gi;
  while ((match = relativeRegex.exec(normalized)) !== null) {
    const rawRel = match[1];
    if (!rawRel.startsWith('http') && !rawRel.startsWith('//') && rawRel.length > 5) {
      const resolved = resolveRelativeUrl(rawRel, baseUrl);
      if (resolved.startsWith('http') && !discoveredMap.has(resolved)) {
        discoveredMap.set(resolved, {
          url: resolved,
          foundVia: `${foundViaLabel} (Relative Path)`,
          folderName,
        });
      }
    }
  }

  const atobRegex = /atob\(\s*["']([A-Za-z0-9+/=]{16,})["']\s*\)/g;
  while ((match = atobRegex.exec(normalized)) !== null) {
    try {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8').trim();
      if (/https?:\/\/[^\s"'<>]+?\.(?:m3u8|mp4|webm)/i.test(decoded)) {
        const cleanDecoded = decoded.match(
          /https?:\/\/[^\s"'<>]+?\.(?:m3u8|mp4|webm)(?:\?[^\s"'<>]*)?/i
        )?.[0];
        if (cleanDecoded && !discoveredMap.has(cleanDecoded)) {
          discoveredMap.set(cleanDecoded, {
            url: cleanDecoded,
            foundVia: `${foundViaLabel} (Decoded from JS atob Base64)`,
            folderName,
          });
        }
      }
    } catch {
      // ignore
    }
  }
}

async function inspectUrlAndExtractStreams(
  inputUrl: string,
  customHeaders?: Record<string, string>,
  rawHtmlSnippet?: string,
  crawlFolders: boolean = true
): Promise<{
  sourceUrl: string;
  pageTitle: string;
  extractedAt: string;
  streams: StreamVariant[];
  folders: string[];
  scriptsScanned: number;
  rawManifestSnippet?: string;
  notes: string[];
}> {
  const notes: string[] = [];
  const streams: StreamVariant[] = [];
  const folderSet = new Set<string>();
  let scriptsScanned = 0;
  let pageTitle = 'Extracted Media Stream';
  let rawManifestSnippet: string | undefined;

  let targetUrl = (inputUrl || '').trim();

  const unwrapped = unwrapQueryRedirectUrl(targetUrl);
  if (unwrapped) {
    notes.push(`Unwrapped embedded stream URL from query parameter: ${unwrapped}`);
    targetUrl = unwrapped;
  }

  if (/^https?:\/\/[^/]*classx\.co\.in\//i.test(targetUrl)) {
    targetUrl = `https://studybeepro.site/api/proxy?url=${encodeURIComponent(targetUrl)}`;
  }

  const baseUrl = targetUrl || 'https://localhost/';
  const headers = buildHeaders(customHeaders, baseUrl);

  // 1A. Check if URL is StudyBeePro / AppX / TeachX Multi-Folder Course / Subject / Topic / Play URL
  try {
    const u = new URL(targetUrl);
    const courseId = u.searchParams.get('courseid') || u.searchParams.get('course_id');
    const subjectId = u.searchParams.get('subjectid') || u.searchParams.get('subject_id');
    const topicId = u.searchParams.get('topicid') || u.searchParams.get('topic_id');
    const videoId = u.searchParams.get('id') || u.searchParams.get('video_id');
    const domainId = u.searchParams.get('domainId') || u.searchParams.get('domain_id') || 'RWA';

    if (
      courseId &&
      (/\/(topic|subject|content|play)\.html$/i.test(u.pathname) || u.searchParams.has('domainId'))
    ) {
      const cfg = await fetchAppxDomainConfig(domainId, u.origin);
      const appxHeaders = {
        'User-Agent': DEFAULT_USER_AGENT,
        'Auth-Key': 'appxapi',
        'User-ID': '32069',
        Authorization: cfg.token,
      };

      // Case 1: Single Video Player page (play.html?id=...&courseid=...)
      if (videoId && /play\.html/i.test(u.pathname)) {
        const resolved = await resolveAppxVideoStreamUrl(
          domainId,
          courseId,
          videoId,
          '720p',
          u.origin
        );
        pageTitle = resolved.title || `Lecture #${videoId}`;
        streams.push({
          id: crypto.randomUUID(),
          url: resolved.streamUrl,
          protocol: 'HLS_MASTER',
          label: pageTitle,
          lectureTitle: pageTitle,
          resolution: resolved.quality,
          foundVia: `AppX Player (${resolved.quality})`,
        });
        return {
          sourceUrl: targetUrl,
          pageTitle,
          extractedAt: new Date().toISOString(),
          streams,
          folders: [],
          scriptsScanned: 1,
          notes,
        };
      }

      // Helper to fetch all videos inside a single topic folder
      const fetchVideosInTopic = async (subjId: string, topId: string, folderLabel: string) => {
        try {
          const contentRes = await fetch(
            `${cfg.apiUrl}/get/livecourseclassbycoursesubtopconceptapiv3?courseid=${encodeURIComponent(
              courseId
            )}&subjectid=${encodeURIComponent(subjId)}&topicid=${encodeURIComponent(
              topId
            )}&conceptid=&start=-1`,
            { headers: appxHeaders }
          );
          if (!contentRes.ok) return [];
          const contentJson = (await contentRes.json()) as any;
          const items: any[] = Array.isArray(contentJson?.data) ? contentJson.data : [];
          return items
            .filter((item) => String(item.material_type || '').toUpperCase() === 'VIDEO' && item.id)
            .map((item) => {
              const title = String(item.Title || `Video #${item.id}`).trim();
              return {
                id: crypto.randomUUID(),
                url: `appx://${encodeURIComponent(domainId)}?courseid=${encodeURIComponent(
                  courseId
                )}&videoid=${encodeURIComponent(String(item.id))}&origin=${encodeURIComponent(
                  u.origin
                )}`,
                protocol: 'HLS_MASTER' as const,
                label: title,
                folderName: folderLabel,
                lectureTitle: title,
                resolution: '720p',
                foundVia: `Folder: ${folderLabel}`,
              };
            });
        } catch {
          return [];
        }
      };

      // Case 2: Specific Topic Folder (content.html?courseid=...&subjectid=...&topicid=...)
      if (subjectId && topicId) {
        const folderName = `Topic #${topicId}`;
        const vids = await fetchVideosInTopic(subjectId, topicId, folderName);
        if (vids.length > 0) {
          folderSet.add(folderName);
          streams.push(...vids);
        }
        pageTitle = `${cfg.name} — Course #${courseId} (${folderName})`;
        return {
          sourceUrl: targetUrl,
          pageTitle,
          extractedAt: new Date().toISOString(),
          streams,
          folders: Array.from(folderSet),
          scriptsScanned: 1,
          notes,
        };
      }

      // Helper to fetch all topics inside a subject and all videos inside each topic
      const fetchAllTopicsForSubject = async (subjId: string, subjectPrefix?: string) => {
        const topicsRes = await fetch(
          `${cfg.apiUrl}/get/alltopicfrmlivecourseclass?courseid=${encodeURIComponent(
            courseId
          )}&subjectid=${encodeURIComponent(subjId)}&start=-3`,
          { headers: appxHeaders }
        );
        if (!topicsRes.ok) return;
        const topicsJson = (await topicsRes.json()) as any;
        const topics: any[] = Array.isArray(topicsJson?.data) ? topicsJson.data : [];

        const topicResults = await Promise.all(
          topics.map(async (topic) => {
            const rawTopicName = String(topic.topic_name || `Topic ${topic.topicid}`).trim();
            const folderLabel = subjectPrefix
              ? `${subjectPrefix} / ${rawTopicName}`
              : rawTopicName;
            const vids = await fetchVideosInTopic(subjId, String(topic.topicid), folderLabel);
            return { folderLabel, vids };
          })
        );

        for (const resItem of topicResults) {
          if (resItem.vids.length > 0) {
            folderSet.add(resItem.folderLabel);
            streams.push(...resItem.vids);
          }
        }
      };

      // Case 3: Subject Topic-List Page (topic.html?courseid=284&subjectid=1677&domainId=RWA)
      if (subjectId) {
        await fetchAllTopicsForSubject(subjectId);
        pageTitle = `${cfg.name} — Course #${courseId} (Subject #${subjectId})`;
        return {
          sourceUrl: targetUrl,
          pageTitle,
          extractedAt: new Date().toISOString(),
          streams,
          folders: Array.from(folderSet),
          scriptsScanned: 1,
          notes,
        };
      }

      // Case 4: Full Course Subject-List Page (subject.html?courseid=284&domainId=RWA)
      const subjRes = await fetch(
        `${cfg.apiUrl}/get/allsubjectfrmlivecourseclass?courseid=${encodeURIComponent(courseId)}`,
        { headers: appxHeaders }
      );
      if (subjRes.ok) {
        const subjJson = (await subjRes.json()) as any;
        const subjects: any[] = Array.isArray(subjJson?.data) ? subjJson.data : [];
        for (const subj of subjects) {
          const sName = String(subj.subject_name || `Subject ${subj.subjectid}`).trim();
          await fetchAllTopicsForSubject(String(subj.subjectid), sName);
        }
        pageTitle = `${cfg.name} — Full Course #${courseId}`;
        return {
          sourceUrl: targetUrl,
          pageTitle,
          extractedAt: new Date().toISOString(),
          streams,
          folders: Array.from(folderSet),
          scriptsScanned: 1,
          notes,
        };
      }
    }
  } catch (appxErr: any) {
    notes.push(`AppX folder scan note: ${appxErr?.message || 'skipped'}`);
  }

  // 1B. Check if URL is a Multi-Folder Course / Batch URL (e.g. /course/:courseId or /course/:courseId/:folderName)
  try {
    const parsedUrlObj = new URL(targetUrl);
    const courseMatch = parsedUrlObj.pathname.match(/\/course\/(\d+)(?:\/([^/?#]+))?/i);
    if (courseMatch) {
      const courseId = courseMatch[1];
      const requestedFolderSlug = courseMatch[2] ? decodeURIComponent(courseMatch[2]).trim() : null;
      const apiContentUrl = `${parsedUrlObj.origin}/api/content`;

      const apiRes = await fetch(apiContentUrl, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ courseId }),
      });

      if (apiRes.ok) {
        const apiJson = (await apiRes.json()) as any;
        if (apiJson && apiJson.success && apiJson.data) {
          const courseData = apiJson.data;
          pageTitle = courseData.courseTitle || courseData.title || `Batch Course #${courseId}`;
          const items: any[] =
            courseData.data || courseData.courseContent || courseData.lectures || [];

          for (const item of items) {
            const videoUrl = item.videoUrl || item.url || item.streamUrl;
            if (!videoUrl || typeof videoUrl !== 'string') continue;

            const folderName = (item.parentTitle || item.folderName || 'General').trim();
            folderSet.add(folderName);

            if (
              requestedFolderSlug &&
              folderName.toLowerCase() !== requestedFolderSlug.toLowerCase()
            ) {
              continue;
            }

            const lectureTitle = (item.name || item.title || 'Lecture Video').trim();
            const isM3u8 = videoUrl.toLowerCase().includes('.m3u8');

            streams.push({
              id: crypto.randomUUID(),
              url: videoUrl,
              protocol: isM3u8 ? 'HLS_MASTER' : 'DIRECT_MP4',
              label: lectureTitle,
              folderName,
              lectureTitle,
              facultyName: item.facultyName || undefined,
              date: item.date || undefined,
              pdfUrl: item.textUploadUrl || undefined,
              foundVia: `Folder: ${folderName}`,
            });
          }

          const folders = Array.from(folderSet);
          return {
            sourceUrl: targetUrl,
            pageTitle: requestedFolderSlug ? `${pageTitle} — ${requestedFolderSlug}` : pageTitle,
            extractedAt: new Date().toISOString(),
            streams,
            folders,
            scriptsScanned: 1,
            notes,
          };
        }
      }
    }
  } catch {
    // Continue to standard HTTP inspection
  }

  if (isUrlPathnameEndingWith(targetUrl, /\.(mp4|webm)$/i)) {
    const isWebm = isUrlPathnameEndingWith(targetUrl, /\.webm$/i);
    const urlPathName = new URL(targetUrl).pathname.split('/').pop() || 'video.mp4';
    pageTitle = decodeURIComponent(urlPathName);
    streams.push({
      id: crypto.randomUUID(),
      url: targetUrl,
      protocol: isWebm ? 'DIRECT_WEBM' : 'DIRECT_MP4',
      label: isWebm ? 'Direct WebM Video' : 'Direct MP4 Video',
      foundVia: 'Direct Video URL',
    });
    return {
      sourceUrl: targetUrl,
      pageTitle,
      extractedAt: new Date().toISOString(),
      streams,
      folders: [],
      scriptsScanned: 0,
      notes,
    };
  }

  const { text: textBody, finalUrl, contentType } = await robustFetchText(targetUrl, headers);

  if (
    textBody.trim().startsWith('#EXTM3U') ||
    (contentType.includes('mpegurl') && !textBody.trim().startsWith('<'))
  ) {
    rawManifestSnippet = textBody.slice(0, 2500);
    const urlName = new URL(finalUrl).pathname.split('/').pop() || 'stream.m3u8';
    pageTitle = `HLS Stream (${decodeURIComponent(urlName)})`;

    streams.push({
      id: 'hls-master-or-media',
      url: finalUrl,
      protocol: 'HLS_MASTER',
      label: pageTitle,
      foundVia: 'Direct HLS Playlist (#EXTM3U)',
    });

    return {
      sourceUrl: finalUrl,
      pageTitle,
      extractedAt: new Date().toISOString(),
      streams,
      folders: [],
      scriptsScanned: 0,
      rawManifestSnippet,
      notes,
    };
  }

  // HTML Webpage — parse DOM, meta tags, inline <script>, external .js, AND Sub-Folders
  const $ = cheerio.load(textBody);
  pageTitle =
    $('title').first().text().trim() || $('meta[property="og:title"]').attr('content') || finalUrl;

  const discovered = new Map<string, { url: string; foundVia: string; folderName?: string }>();

  const parseHtmlDomIntoDiscovered = (
    cheerioInstance: cheerio.CheerioAPI,
    pageBaseUrl: string,
    folderLabel?: string
  ) => {
    cheerioInstance('video, video source, source').each((_, el) => {
      const src =
        cheerioInstance(el).attr('src') ||
        cheerioInstance(el).attr('data-src') ||
        cheerioInstance(el).attr('data-url');
      if (src) {
        const abs = resolveRelativeUrl(src, pageBaseUrl);
        discovered.set(abs, {
          url: abs,
          foundVia: folderLabel ? `Folder [${folderLabel}] <video>` : 'HTML5 <video>',
          folderName: folderLabel,
        });
      }
    });

    cheerioInstance('a[href]').each((_, el) => {
      const href = cheerioInstance(el).attr('href');
      if (!href) return;
      const abs = resolveRelativeUrl(href, pageBaseUrl);
      const unwrappedLink = unwrapQueryRedirectUrl(abs) || abs;
      if (/\.(m3u8|mp4|webm)(\?.*)?$/i.test(unwrappedLink)) {
        const linkText = cheerioInstance(el).text().trim();
        discovered.set(unwrappedLink, {
          url: unwrappedLink,
          foundVia: folderLabel
            ? `Folder [${folderLabel}]${linkText ? ` — ${linkText}` : ''}`
            : linkText || 'Page Link',
          folderName: folderLabel,
        });
      }
    });

    cheerioInstance(
      'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]'
    ).each((_, el) => {
      const content = cheerioInstance(el).attr('content');
      if (content) {
        const abs = resolveRelativeUrl(content, pageBaseUrl);
        discovered.set(abs, {
          url: abs,
          foundVia: folderLabel ? `Folder [${folderLabel}] Meta` : 'OpenGraph Video Tag',
          folderName: folderLabel,
        });
      }
    });

    cheerioInstance(
      '[data-video], [data-mp4], [data-m3u8], [data-hls], [data-stream-url]'
    ).each((_, el) => {
      const elFolder = cheerioInstance(el).attr('data-folder') || folderLabel;
      for (const attr of ['data-video', 'data-mp4', 'data-m3u8', 'data-hls', 'data-stream-url']) {
        const val = cheerioInstance(el).attr(attr);
        if (val) {
          const abs = resolveRelativeUrl(val, pageBaseUrl);
          discovered.set(abs, {
            url: abs,
            foundVia: elFolder ? `Folder [${elFolder}]` : `DOM Attribute [${attr}]`,
            folderName: elFolder,
          });
        }
      }
    });
  };

  parseHtmlDomIntoDiscovered($, finalUrl);

  const externalScriptUrls: string[] = [];
  $('script').each((_, el) => {
    const src = $(el).attr('src');
    if (src) {
      externalScriptUrls.push(resolveRelativeUrl(src, finalUrl));
    }
    const inlineCode = $(el).html();
    if (inlineCode && inlineCode.trim().length > 0) {
      scriptsScanned++;
      extractStreamsFromJsOrText(inlineCode, finalUrl, 'Inline <script> JS Inspector', discovered);
    }
  });

  extractStreamsFromJsOrText(textBody, finalUrl, 'HTML Source Regex Scanner', discovered);

  if (crawlFolders) {
    const subFolderLinks: { url: string; name: string }[] = [];
    const seenSubUrls = new Set<string>([finalUrl]);

    $('a[href], [data-folder-url]').each((_, el) => {
      const rawHref = $(el).attr('data-folder-url') || $(el).attr('href');
      if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) return;
      const abs = resolveRelativeUrl(rawHref, finalUrl);
      if (seenSubUrls.has(abs)) return;

      try {
        const mainU = new URL(finalUrl);
        const subU = new URL(abs);
        if (subU.origin !== mainU.origin) return;
        const isSubFolder =
          subU.pathname.endsWith('/') ||
          /\/(folder|course|batch|chapter|module|subject|playlist|lecture|episode|topic|dir)\b/i.test(
            subU.pathname
          ) ||
          (subU.pathname.startsWith(mainU.pathname) && subU.pathname.length > mainU.pathname.length + 1);

        if (isSubFolder && !/\.(jpg|jpeg|png|gif|css|pdf|zip|svg)$/i.test(subU.pathname)) {
          seenSubUrls.add(abs);
          const folderTitle =
            $(el).attr('data-folder-name') ||
            $(el).text().trim().replace(/\s+/g, ' ').slice(0, 60) ||
            decodeURIComponent(subU.pathname.split('/').filter(Boolean).pop() || 'Subfolder');
          subFolderLinks.push({ url: abs, name: folderTitle });
        }
      } catch {
        // ignore
      }
    });

    if (subFolderLinks.length > 0) {
      const foldersToCrawl = subFolderLinks.slice(0, 12);
      await Promise.all(
        foldersToCrawl.map(async (sub) => {
          try {
            const { text: subHtml } = await robustFetchText(sub.url, headers, 2);
            const sub$ = cheerio.load(subHtml);
            folderSet.add(sub.name);
            parseHtmlDomIntoDiscovered(sub$, sub.url, sub.name);
            extractStreamsFromJsOrText(
              subHtml,
              sub.url,
              `Folder [${sub.name}] JS`,
              discovered,
              sub.name
            );
          } catch {
            // ignore
          }
        })
      );
    }
  }

  const filteredExternalScripts = externalScriptUrls
    .filter((u) => !/google-analytics|googletagmanager|fbevents|doubleclick/i.test(u))
    .slice(0, 4);

  await Promise.all(
    filteredExternalScripts.map(async (jsUrl) => {
      try {
        const { text: jsText } = await robustFetchText(jsUrl, headers, 2);
        scriptsScanned++;
        extractStreamsFromJsOrText(
          jsText,
          finalUrl,
          `External JS (${jsUrl.split('/').pop()})`,
          discovered
        );
      } catch {
        // ignore
      }
    })
  );

  for (const item of discovered.values()) {
    if (item.folderName) {
      folderSet.add(item.folderName);
    }
    const lower = item.url.toLowerCase();
    streams.push({
      id: crypto.randomUUID(),
      url: item.url,
      protocol: lower.includes('.m3u8')
        ? 'HLS_MASTER'
        : lower.includes('.webm')
        ? 'DIRECT_WEBM'
        : 'DIRECT_MP4',
      label: item.foundVia,
      folderName: item.folderName,
      foundVia: item.foundVia,
    });
  }

  return {
    sourceUrl: finalUrl,
    pageTitle,
    extractedAt: new Date().toISOString(),
    streams,
    folders: Array.from(folderSet),
    scriptsScanned,
    rawManifestSnippet,
    notes,
  };
}

// ============================================================================
// TELEGRAM BOT API (NATIVE CURL STREAMING) & GRAMJS MTPROTO USERBOT RELAY
// ============================================================================

let cachedUserbotClient: TelegramClient | null = null;
let cachedUserbotSessionKey = '';
let botInfoCache: { username?: string; firstName?: string; connected: boolean; error?: string } = {
  connected: false,
};

async function getConnectedUserbotClient(): Promise<TelegramClient | null> {
  const apiIdStr = process.env.TELEGRAM_API_ID?.trim();
  const apiHash = process.env.TELEGRAM_API_HASH?.trim();
  const stringSession = process.env.TELEGRAM_STRING_SESSION?.trim();

  if (!apiIdStr || !apiHash || !stringSession) {
    return null;
  }
  const apiId = parseInt(apiIdStr, 10);
  if (isNaN(apiId)) return null;

  const key = `${apiId}:${apiHash}:${stringSession.slice(0, 24)}`;
  if (cachedUserbotClient && cachedUserbotSessionKey === key && cachedUserbotClient.connected) {
    return cachedUserbotClient;
  }

  const client = new TelegramClient(new StringSession(stringSession), apiId, apiHash, {
    connectionRetries: 3,
  });
  await client.connect();
  cachedUserbotClient = client;
  cachedUserbotSessionKey = key;
  return client;
}

async function sendTelegramTextMessage(
  chatId: string | number,
  text: string,
  replyMarkup?: Record<string, any>
): Promise<number | undefined> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return undefined;
  try {
    const payload: Record<string, any> = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as any;
    return data?.result?.message_id;
  } catch {
    return undefined;
  }
}

async function editTelegramTextMessage(
  chatId: string | number,
  messageId: number | undefined,
  text: string,
  replyMarkup?: Record<string, any>
) {
  if (!messageId) return;
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;
  try {
    const payload: Record<string, any> = {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // ignore edit rate limit
  }
}

async function answerTelegramCallbackQuery(callbackQueryId: string, text?: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: false,
      }),
    });
  } catch {
    // ignore
  }
}

const BOT_COMMANDS_LIST = [
  { command: 'features', description: '📋 All Bot Features & Interactive Control Menu' },
  { command: 'quality', description: '🎞 Change Default Video Quality (360p / 480p / 720p / 1080p)' },
  { command: 'mode', description: '🎬 Toggle Full Single Video (2GB) vs Split Parts Mode' },
  { command: 'channels', description: '🛡️ View Saved Backup Channels & Fix-Link Rules' },
  { command: 'addbackup', description: '➕ Add Backup Channel or Group for Auto-Save' },
  { command: 'route', description: '🎯 Set Fix Link -> Fix Channel Rule' },
  { command: 'queue', description: '📊 Check Active Download Queue & Speed' },
  { command: 'stop', description: '🛑 Stop & Clear Pending Downloads' },
  { command: 'start', description: '⚡ Bot Status & Quick Start' },
  { command: 'help', description: 'ℹ️ Full Commands & Usage Guide' },
];

async function registerTelegramBotMenu(token: string) {
  try {
    // Register commands for all scopes so Menu button shows in Private chats & Groups
    const scopes = [
      { type: 'default' },
      { type: 'all_private_chats' },
      { type: 'all_group_chats' },
    ];
    for (const scope of scopes) {
      await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commands: BOT_COMMANDS_LIST,
          scope,
        }),
      });
    }

    // Set the bottom-left chat Menu Button to open the Commands menu
    await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        menu_button: {
          type: 'commands',
        },
      }),
    });
    addBotLog('SYSTEM', 'bot', 'Registered Telegram Bot Menu Button (/features & all commands)');
  } catch (err: any) {
    console.error('Failed to register Telegram Bot menu commands:', err?.message || err);
  }
}

function buildFeaturesMenuPayload(chatId: string, senderId?: string) {
  const authSession =
    botSettings.authorizedUsers[chatId] ||
    (senderId ? botSettings.authorizedUsers[senderId] : undefined);
  const remHours = authSession
    ? Math.max(
        1,
        Math.round((new Date(authSession.expiresAt).getTime() - Date.now()) / (1000 * 3600))
      )
    : 24;

  const q = (botSettings.globalDefaultQuality || '720p').toLowerCase();
  const fullMode = botSettings.preferFullSingleVideo !== false;
  const activeBackups = botSettings.backupChannels.filter((b) => b.enabled);
  const activeRoutes = botSettings.routeRules.filter((r) => r.enabled);
  const userQueue = chatJobQueues.get(chatId) || [];
  const activeRunning = Array.from(jobs.values()).filter(
    (j) => j.telegramChatId === chatId && (j.status === 'downloading' || j.status === 'converting' || j.status === 'uploading')
  ).length;

  const text =
    `📋 StreamBridge Bot — All Features Menu (/features)\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🔑 Access Status: Active (${remHours}h left)\n` +
    `🎞 Default Quality: ${q.toUpperCase()} (Auto-select before play)\n` +
    `🎬 Delivery Mode: ${fullMode ? 'Full Single Video (Puri Video up to 2GB)' : 'Fast Split Parts (<48MB)'}\n` +
    `🛡️ Backup Channels/Groups: ${activeBackups.length} active\n` +
    `🎯 Fix-Link -> Channel Rules: ${activeRoutes.length} active\n` +
    `📊 Your Queue: ${activeRunning} active, ${userQueue.length} waiting\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `✨ Available Bot Features:\n` +
    `1️⃣ Direct HLS (.m3u8), MP4 & JS-Player Video Downloader\n` +
    `2️⃣ Deep Multi-Folder & Course Extractor (e.g. StudyBee / RWA / Course Topics)\n` +
    `3️⃣ Auto Quality Selector (${q.toUpperCase()} default before video plays)\n` +
    `4️⃣ Puri Video (Up to 2GB Single Streamable MP4 via Userbot)\n` +
    `5️⃣ Auto-Backup Vault (Saves every video to your Backup Channels/Groups)\n` +
    `6️⃣ Fix Link -> Fix Channel Routing (<url> -> <channel_id> or /route)\n\n` +
    `👇 Neeche diye gaye buttons se koi bhi feature/setting control karein:`;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: `${q === '360p' ? '✅ ' : ''}360p`, callback_data: 'feat:q:360p' },
        { text: `${q === '480p' ? '✅ ' : ''}480p`, callback_data: 'feat:q:480p' },
        { text: `${q === '720p' ? '✅ ' : ''}720p HD`, callback_data: 'feat:q:720p' },
        { text: `${q === '1080p' ? '✅ ' : ''}1080p`, callback_data: 'feat:q:1080p' },
      ],
      [
        {
          text: fullMode
            ? '🎬 Mode: Puri Video (Up to 2GB) ✅'
            : '🎬 Switch to Puri Video (2GB)',
          callback_data: 'feat:mode:full',
        },
        {
          text: !fullMode ? '⚡ Mode: Split (<48MB) ✅' : '⚡ Switch to Split Mode',
          callback_data: 'feat:mode:split',
        },
      ],
      [
        {
          text: `🛡️ Backup Channels (${activeBackups.length})`,
          callback_data: 'feat:view:channels',
        },
        {
          text: '➕ Add Backup Channel',
          callback_data: 'feat:help:addbackup',
        },
      ],
      [
        {
          text: `🎯 Fix Link -> Channel (${activeRoutes.length})`,
          callback_data: 'feat:help:route',
        },
        {
          text: '📂 Multi-Folder Course Guide',
          callback_data: 'feat:help:course',
        },
      ],
      [
        {
          text: `📊 Queue Status (${activeRunning + userQueue.length})`,
          callback_data: 'feat:view:queue',
        },
        {
          text: '🛑 Stop & Clear Queue',
          callback_data: 'feat:action:stop',
        },
      ],
      [
        {
          text: '🔄 Refresh /features Menu',
          callback_data: 'feat:refresh',
        },
      ],
    ],
  };

  return { text, replyMarkup };
}

interface VideoProbeMeta {
  duration: number;
  width: number;
  height: number;
  thumbPath?: string;
}

async function probeVideoMetadataAndThumb(mp4Path: string, jobId: string): Promise<VideoProbeMeta> {
  const meta: VideoProbeMeta = {
    duration: 0,
    width: 1280,
    height: 720,
  };
  if (!ffmpegAvailable || !fs.existsSync(mp4Path)) {
    return meta;
  }

  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-show_entries',
      'format=duration',
      '-of',
      'json',
      mp4Path,
    ]);
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{ width?: number; height?: number }>;
      format?: { duration?: string };
    };
    if (parsed.streams && parsed.streams[0]) {
      if (parsed.streams[0].width) meta.width = Number(parsed.streams[0].width);
      if (parsed.streams[0].height) meta.height = Number(parsed.streams[0].height);
    }
    if (parsed.format?.duration) {
      const dur = parseFloat(parsed.format.duration);
      if (Number.isFinite(dur) && dur > 0) {
        meta.duration = Math.round(dur);
      }
    }
  } catch {
    // ignore probe error
  }

  try {
    const thumbPath = path.join(DOWNLOAD_DIR, `${jobId}_thumb.jpg`);
    const seekSec = meta.duration > 10 ? '00:00:04' : '00:00:01';
    await execFileAsync('ffmpeg', [
      '-y',
      '-ss',
      seekSec,
      '-i',
      mp4Path,
      '-frames:v',
      '1',
      '-q:v',
      '5',
      '-vf',
      'scale=320:-2',
      thumbPath,
    ]);
    if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 200) {
      meta.thumbPath = thumbPath;
    }
  } catch {
    // ignore thumbnail error
  }

  return meta;
}

async function copyTelegramVideoMessage(
  fromChatId: string | number,
  messageId: number,
  toChatId: string | number,
  caption: string
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/copyMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: String(toChatId).trim(),
        from_chat_id: String(fromChatId).trim(),
        message_id: messageId,
        caption,
      }),
    });
    const data = (await res.json()) as { ok: boolean; description?: string };
    return Boolean(data.ok);
  } catch {
    return false;
  }
}

// Uses native libcurl multipart streaming directly from disk — 50 MB/s with full duration, resolution & thumbnail!
async function uploadToTelegramBotApi(
  filePath: string,
  chatId: string,
  caption: string,
  meta?: VideoProbeMeta
): Promise<{ ok: boolean; error?: string; messageId?: number; fromChatId?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured in Secrets.' };
  }

  try {
    const curlArgs = [
      '-s',
      '--retry',
      '3',
      '--max-time',
      '180',
      '-X',
      'POST',
      `https://api.telegram.org/bot${token}/sendVideo`,
      '-F',
      `chat_id=${chatId}`,
      '-F',
      `caption=${caption}`,
      '-F',
      'supports_streaming=true',
    ];
    if (meta?.duration && meta.duration > 0) {
      curlArgs.push('-F', `duration=${Math.round(meta.duration)}`);
    }
    if (meta?.width && meta.width > 0) {
      curlArgs.push('-F', `width=${meta.width}`);
    }
    if (meta?.height && meta.height > 0) {
      curlArgs.push('-F', `height=${meta.height}`);
    }
    if (meta?.thumbPath && fs.existsSync(meta.thumbPath)) {
      curlArgs.push('-F', `thumbnail=@${meta.thumbPath}`);
    }
    curlArgs.push('-F', `video=@${filePath}`);

    const { stdout } = await execFileAsync('curl', curlArgs, {
      maxBuffer: 10 * 1024 * 1024,
    });
    const data = JSON.parse(stdout) as {
      ok: boolean;
      description?: string;
      result?: { message_id: number; chat?: { id: number | string } };
    };
    if (!data.ok) {
      return { ok: false, error: data.description || 'Telegram Bot API sendVideo failed' };
    }
    return {
      ok: true,
      messageId: data.result?.message_id,
      fromChatId: String(data.result?.chat?.id || chatId),
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'curl sendVideo failed' };
  }
}

async function uploadToTelegramUserbotMtproto(
  jobId: string,
  filePath: string,
  allTargetChatIds: string[],
  caption: string,
  meta?: VideoProbeMeta,
  onProgress?: (percent: number) => void
): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = await getConnectedUserbotClient();
    if (!client) {
      return {
        ok: false,
        error: 'MTProto Userbot is not configured.',
      };
    }

    const stat = await fs.promises.stat(filePath);
    const fileName = path.basename(filePath);
    const toUpload = new CustomFile(fileName, stat.size, filePath);

    const videoAttributes = [
      new Api.DocumentAttributeVideo({
        duration: Math.round(meta?.duration || 0),
        w: meta?.width || 1280,
        h: meta?.height || 720,
        supportsStreaming: true,
      }),
      new Api.DocumentAttributeFilename({
        fileName,
      }),
    ];

    const uniqueTargets = Array.from(
      new Set(allTargetChatIds.map((id) => id.trim()).filter(Boolean))
    );

    if (botInfoCache.username && uniqueTargets.length > 0) {
      const primaryChatId = uniqueTargets[0];
      const relayTag = `#RELAY_${primaryChatId}_${jobId}#`;
      let resolveRelay!: (info?: { fromChatId: string; messageId: number }) => void;
      const relayPromise = new Promise<{ fromChatId: string; messageId: number } | undefined>(
        (resolve) => {
          resolveRelay = resolve;
        }
      );

      pendingUserbotRelays.set(relayTag, {
        allTargetChatIds: uniqueTargets,
        cleanCaption: caption,
        resolve: resolveRelay,
      });

      await client.sendFile(`@${botInfoCache.username}`, {
        file: toUpload,
        caption: `${relayTag}\n${caption}`,
        forceDocument: false,
        attributes: videoAttributes,
        thumb: meta?.thumbPath && fs.existsSync(meta.thumbPath) ? meta.thumbPath : undefined,
        workers: 16,
        progressCallback: (progress: number) => {
          if (onProgress) {
            onProgress(Math.round(progress * 100));
          }
        },
      });

      // Wait up to 20 seconds AFTER client.sendFile completes for getUpdates to receive & copyMessage to all targets
      await Promise.race([
        relayPromise,
        new Promise<undefined>((r) =>
          setTimeout(() => {
            pendingUserbotRelays.delete(relayTag);
            r(undefined);
          }, 20000)
        ),
      ]);
      return { ok: true };
    }

    await client.sendFile('me', {
      file: toUpload,
      caption,
      forceDocument: false,
      attributes: videoAttributes,
      thumb: meta?.thumbPath && fs.existsSync(meta.thumbPath) ? meta.thumbPath : undefined,
      workers: 16,
      progressCallback: (progress: number) => {
        if (onProgress) {
          onProgress(Math.round(progress * 100));
        }
      },
    });

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'MTProto Userbot upload error' };
  }
}

// Fast 34MB FFmpeg Stream Splitter (Used only if Userbot is unavailable or Split Mode is explicitly enabled)
async function splitMp4IntoFastPartsIfNeeded(filePath: string): Promise<string[]> {
  const stat = await fs.promises.stat(filePath);
  const sizeMb = stat.size / (1024 * 1024);
  if (sizeMb <= 47.5 || !ffmpegAvailable) {
    return [filePath];
  }
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const outPattern = path.join(dir, `${base}_part%02d${ext}`);

  let durationSec = 3600;
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const parsedDur = parseFloat(stdout.trim());
    if (Number.isFinite(parsedDur) && parsedDur > 10) {
      durationSec = parsedDur;
    }
  } catch {
    // fallback if ffprobe fails
  }

  const numParts = Math.max(2, Math.ceil(sizeMb / 34));
  const segTimeSec = Math.max(60, Math.floor(durationSec / numParts));

  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      filePath,
      '-c',
      'copy',
      '-map',
      '0',
      '-f',
      'segment',
      '-segment_time',
      String(segTimeSec),
      '-reset_timestamps',
      '1',
      outPattern,
    ]);
    const files = (await fs.promises.readdir(dir))
      .filter((f) => f.startsWith(`${base}_part`) && f.endsWith(ext))
      .sort()
      .map((f) => path.join(dir, f));
    if (files.length > 0) {
      return files;
    }
  } catch {
    // fallback
  }
  return [filePath];
}

// ============================================================================
// SLIDING-WINDOW CONCURRENT HLS DOWNLOADER (100% COMPLETE PURI VIDEO + MULTI-CHANNEL BACKUP)
// ============================================================================

async function processDownloadJob(job: DownloadJob): Promise<void> {
  const startTime = Date.now();
  let lastTelegramUpdateTime = 0;

  if (!job.preferredQuality || job.preferredQuality === 'auto_fast') {
    job.preferredQuality = botSettings.globalDefaultQuality || '720p';
  }

  const targetChat = (job.telegramChatId || process.env.TELEGRAM_CHAT_ID || '').trim();

  // Check if this job matches a Fix Link -> Fix Channel Rule or has an explicit target channel
  const matchedRoute = findMatchingRouteRule(job.originalRequestUrl || job.sourceUrl);
  const routedChannelId = (
    job.explicitTargetChannelId ||
    matchedRoute?.targetChatId ||
    ''
  ).trim();
  const routedChannelLabel =
    matchedRoute?.targetTitle || matchedRoute?.label || job.explicitTargetChannelId || '';

  // Collect all active Backup Channels / Backup Groups
  const enabledBackups = botSettings.backupChannels.filter(
    (b) => b.enabled && b.chatId && b.chatId.trim()
  );

  if (targetChat && !job.telegramStatusMsgId) {
    const destNote = routedChannelId
      ? `\n🎯 Target Channel: ${routedChannelLabel || routedChannelId}`
      : enabledBackups.length > 0
      ? `\n🛡️ Auto-Backup: ${enabledBackups.length} channel/group(s)`
      : '';
    job.telegramStatusMsgId = await sendTelegramTextMessage(
      targetChat,
      `⚡ Starting Full Video Download (${job.preferredQuality.toUpperCase()}): ${job.title}` +
        (job.folderName ? `\n📁 Folder: ${job.folderName}` : '') +
        destNote
    );
  }

  const updateTelegramProgressIfNeeded = async (text: string, force = false) => {
    if (!targetChat || !job.telegramStatusMsgId) return;
    const now = Date.now();
    if (force || now - lastTelegramUpdateTime > 3000) {
      lastTelegramUpdateTime = now;
      await editTelegramTextMessage(targetChat, job.telegramStatusMsgId, text);
    }
  };

  try {
    job.status = 'downloading';

    // Resolve lazy AppX / StudyBeePro video URLs right when the job starts
    if (job.sourceUrl.startsWith('appx://')) {
      const parsedAppx = new URL(job.sourceUrl.replace(/^appx:\/\//i, 'http://'));
      const domainId = decodeURIComponent(parsedAppx.hostname || 'RWA').toUpperCase();
      const courseId = parsedAppx.searchParams.get('courseid') || '284';
      const videoId = parsedAppx.searchParams.get('videoid') || '';
      const origin = parsedAppx.searchParams.get('origin') || 'https://studybeepro.site';

      const resolved = await resolveAppxVideoStreamUrl(
        domainId,
        courseId,
        videoId,
        job.preferredQuality || botSettings.globalDefaultQuality || '720p',
        origin
      );
      job.sourceUrl = resolved.streamUrl;
      job.resolution = resolved.quality;
    }

    const unwrappedSource = unwrapQueryRedirectUrl(job.sourceUrl);
    if (unwrappedSource) {
      job.sourceUrl = unwrappedSource;
    }

    if (/^https?:\/\/[^/]*classx\.co\.in\//i.test(job.sourceUrl)) {
      job.sourceUrl = `https://studybeepro.site/api/proxy?url=${encodeURIComponent(job.sourceUrl)}`;
    }

    const headers = buildHeaders(job.customHeaders, job.sourceUrl);
    const safeBaseName = job.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 45) || 'video';

    const isDirectVideoUrl = isUrlPathnameEndingWith(job.sourceUrl, /\.(mp4|webm)$/i);

    if (!isDirectVideoUrl) {
      const { text: textBody, finalUrl } = await robustFetchText(job.sourceUrl, headers);
      if (!textBody.trim().startsWith('#EXTM3U')) {
        throw new Error('Target URL did not return a valid #EXTM3U playlist.');
      }

      let mediaPlaylist = parseM3u8Content(textBody, finalUrl);

      if (mediaPlaylist.isMaster) {
        if (mediaPlaylist.variants.length === 0) {
          throw new Error('HLS Master playlist contained no playable variants.');
        }
        const chosenVariant = chooseVariantByPreferredQuality(
          mediaPlaylist.variants,
          job.preferredQuality || botSettings.globalDefaultQuality || '720p'
        );
        job.resolution = chosenVariant.resolution || chosenVariant.name || job.resolution;
        const { text: varText, finalUrl: varFinalUrl } = await robustFetchText(
          chosenVariant.url,
          headers
        );
        const subParsed = parseM3u8Content(varText, varFinalUrl);
        if (subParsed.isMaster) {
          throw new Error('Nested HLS Master playlist could not be resolved to media segments.');
        }
        mediaPlaylist = subParsed;
      }

      const segments = mediaPlaylist.segments;
      if (segments.length === 0) {
        throw new Error('No media segments (#EXTINF) found in the HLS playlist.');
      }

      job.totalSegments = segments.length;
      job.completedSegments = 0;

      const rawTsPath = path.join(DOWNLOAD_DIR, `${job.id}_${safeBaseName}.ts`);
      const writeStream = fs.createWriteStream(rawTsPath);

      if (mediaPlaylist.initMapUrl) {
        const mapBuf = await robustFetchBuffer(mediaPlaylist.initMapUrl, headers, 6);
        writeStream.write(mapBuf);
        job.downloadedBytes += mapBuf.length;
      }

      const keyCache = new Map<string, Buffer>();

      // 16 Steady Workers with 7 Retries per segment so 100% of segments download completely without CDN rate-limit drops
      const WORKER_COUNT = 16;
      let nextFetchIndex = 0;
      let nextWriteIndex = 0;
      const completedBuffers = new Map<number, Buffer>();
      let isFlushing = false;

      const flushOrderedBuffers = async () => {
        if (isFlushing) return;
        isFlushing = true;
        while (completedBuffers.has(nextWriteIndex)) {
          const buf = completedBuffers.get(nextWriteIndex)!;
          completedBuffers.delete(nextWriteIndex);
          nextWriteIndex++;
          if (buf.length > 0) {
            if (!writeStream.write(buf)) {
              await new Promise<void>((r) => writeStream.once('drain', () => r()));
            }
          }
        }
        isFlushing = false;
      };

      const workerTask = async () => {
        while (true) {
          const segIndex = nextFetchIndex++;
          if (segIndex >= segments.length) break;

          const seg = segments[segIndex];
          let buf: Buffer;
          try {
            buf = await robustFetchBuffer(seg.url, headers, 7);

            if (seg.key && seg.key.method === 'AES-128' && seg.key.uri) {
              let keyBuf = keyCache.get(seg.key.uri);
              if (!keyBuf) {
                keyBuf = await robustFetchBuffer(seg.key.uri, headers, 5);
                keyCache.set(seg.key.uri, keyBuf);
              }
              if (keyBuf && keyBuf.length === 16) {
                let ivBuf: Buffer;
                if (seg.key.iv) {
                  const cleanHex = seg.key.iv.replace(/^0x/i, '').padStart(32, '0');
                  ivBuf = Buffer.from(cleanHex, 'hex');
                } else {
                  ivBuf = Buffer.alloc(16, 0);
                  ivBuf.writeUInt32BE(segIndex, 12);
                }
                const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, ivBuf);
                buf = Buffer.concat([decipher.update(buf), decipher.final()]);
              }
            }
          } catch {
            buf = Buffer.alloc(0);
          }

          completedBuffers.set(segIndex, buf);
          job.completedSegments++;
          job.downloadedBytes += buf.length;
          const elapsedSec = Math.max(0.5, (Date.now() - startTime) / 1000);
          job.speedBytesPerSec = Math.round(job.downloadedBytes / elapsedSec);
          job.progressPercent = Math.min(95, Math.round((job.completedSegments / job.totalSegments) * 95));

          await flushOrderedBuffers();

          const speedMb = (job.speedBytesPerSec / (1024 * 1024)).toFixed(1);
          const dlMb = (job.downloadedBytes / (1024 * 1024)).toFixed(1);
          updateTelegramProgressIfNeeded(
            `⚡ Downloading Full Video (${job.resolution || job.preferredQuality || '720p'}): ${job.title}\n` +
              (job.folderName ? `📁 Folder: ${job.folderName}\n` : '') +
              `📊 ${job.progressPercent}% (${job.completedSegments}/${job.totalSegments} segments)\n` +
              `🚀 Speed: ${speedMb} MB/s • Size: ${dlMb} MB`
          );
        }
      };

      const workers = Array.from({ length: Math.min(WORKER_COUNT, segments.length) }, () =>
        workerTask()
      );
      await Promise.all(workers);
      await flushOrderedBuffers();

      await new Promise<void>((resolve, reject) => {
        writeStream.end(() => resolve());
        writeStream.on('error', reject);
      });

      if (ffmpegAvailable) {
        job.status = 'merging';
        await updateTelegramProgressIfNeeded(
          `🔧 Packaging Full Streamable MP4 (Fixing Timestamps & Audio): ${job.title}...`,
          true
        );
        const mp4Path = path.join(DOWNLOAD_DIR, `${job.id}_${safeBaseName}.mp4`);
        try {
          await execFileAsync('ffmpeg', [
            '-y',
            '-fflags',
            '+genpts+igndts+discardcorrupt',
            '-i',
            rawTsPath,
            '-map',
            '0:v:0?',
            '-map',
            '0:a:0?',
            '-c',
            'copy',
            '-bsf:a',
            'aac_adtstoasc',
            '-movflags',
            '+faststart',
            mp4Path,
          ]);
          try {
            fs.unlinkSync(rawTsPath);
          } catch {
            // ignore
          }
          job.filePath = mp4Path;
          job.outputFormat = 'mp4';
        } catch {
          job.filePath = rawTsPath;
          job.outputFormat = 'ts';
        }
      } else {
        job.filePath = rawTsPath;
        job.outputFormat = 'ts';
      }
    } else {
      job.totalSegments = 1;
      const ext = job.protocol === 'DIRECT_WEBM' ? 'webm' : 'mp4';
      const outPath = path.join(DOWNLOAD_DIR, `${job.id}_${safeBaseName}.${ext}`);
      await execFileAsync('curl', ['-sL', '--retry', '4', '-o', outPath, job.sourceUrl]);
      const stat = await fs.promises.stat(outPath);
      job.downloadedBytes = stat.size;
      job.completedSegments = 1;
      job.filePath = outPath;
      job.outputFormat = 'mp4';
    }

    job.fileReadyForBrowser = true;

    // 2. Upload Full Video to User + Fixed Routed Channel + All Active Backup Channels/Groups
    if ((job.deliveryMode === 'telegram_auto' || job.deliveryMode === 'telegram_userbot') && job.filePath) {
      const backupIds = enabledBackups.map((b) => b.chatId.trim());
      const allDestChatIds = Array.from(
        new Set([targetChat, routedChannelId, ...backupIds].filter(Boolean))
      );

      if (allDestChatIds.length === 0) {
        throw new Error('No Telegram Chat ID or Backup Channel configured.');
      }

      const primaryChat = allDestChatIds[0];
      const secondaryChatIds = allDestChatIds.slice(1);

      const stat = await fs.promises.stat(job.filePath);
      const sizeMb = stat.size / (1024 * 1024);
      const videoMeta = await probeVideoMetadataAndThumb(job.filePath, job.id);
      const durMin =
        videoMeta.duration > 0
          ? `⏱ Duration: ${Math.floor(videoMeta.duration / 60)}m ${videoMeta.duration % 60}s\n`
          : '';
      const folderLine = job.folderName ? `📁 Folder: ${job.folderName}\n` : '';
      const resLine = `🎞 Quality: ${job.resolution || `${videoMeta.width}x${videoMeta.height}`}\n`;
      const caption = `🎬 ${job.title}\n${folderLine}${resLine}${durMin}📦 Size: ${sizeMb.toFixed(2)} MB`;

      const hasUserbotConfigured = Boolean(
        process.env.TELEGRAM_API_ID?.trim() &&
          process.env.TELEGRAM_API_HASH?.trim() &&
          process.env.TELEGRAM_STRING_SESSION?.trim()
      );

      // CASE A: Video <= 49 MB -> Upload Full Single Video via Fast Bot API + Copy to all Backup/Routed Channels
      if (sizeMb <= 49.0 && job.deliveryMode !== 'telegram_userbot') {
        job.status = 'uploading_bot_api';
        await updateTelegramProgressIfNeeded(
          `📤 Uploading Full Video (${sizeMb.toFixed(1)} MB) to Telegram & ${
            enabledBackups.length
          } Backup Channel(s)...`,
          true
        );
        const upRes = await uploadToTelegramBotApi(job.filePath, primaryChat, caption, videoMeta);
        if (!upRes.ok) {
          throw new Error(upRes.error);
        }

        // Copy to all other destinations (Routed Channel + Backup Channels/Groups) in 0.2s!
        if (upRes.messageId && upRes.fromChatId && secondaryChatIds.length > 0) {
          for (const destId of secondaryChatIds) {
            await copyTelegramVideoMessage(upRes.fromChatId, upRes.messageId, destId, caption);
          }
        }

        job.telegramResult = {
          deliveredVia: 'BOT_API_50MB',
          chatId: primaryChat,
          fileSizeMb: sizeMb.toFixed(2),
          timestamp: new Date().toISOString(),
          backedUpTo: enabledBackups.map((b) => b.title),
          routedToChannel: routedChannelLabel || undefined,
        };
        addBotLog(
          'OUTGOING',
          primaryChat,
          `Delivered FULL video ${job.title} (${sizeMb.toFixed(2)} MB) to ${allDestChatIds.length} destination(s).`
        );
      } else if (botSettings.preferFullSingleVideo && hasUserbotConfigured) {
        // CASE B: Video > 49 MB & Full Single Video Mode (Default) -> Upload 100% FULL UNSPLIT MP4 via 2GB Userbot & Relay to User + All Backup/Routed Channels!
        job.status = 'uploading_mtproto_userbot';
        await updateTelegramProgressIfNeeded(
          `📤 Uploading FULL Single Video (${sizeMb.toFixed(1)} MB) via 2GB Userbot ( + ${
            enabledBackups.length
          } Backup Channel)...`,
          true
        );
        const upRes = await uploadToTelegramUserbotMtproto(
          job.id,
          job.filePath,
          allDestChatIds,
          caption,
          videoMeta,
          (pct) => {
            job.progressPercent = Math.min(99, 95 + Math.round(pct * 0.04));
            updateTelegramProgressIfNeeded(
              `📤 Uploading FULL Video (${sizeMb.toFixed(1)} MB) via 2GB Userbot: ${pct}%...`
            );
          }
        );

        if (upRes.ok) {
          job.telegramResult = {
            deliveredVia: 'MTPROTO_USERBOT_2GB',
            chatId: primaryChat,
            fileSizeMb: sizeMb.toFixed(2),
            timestamp: new Date().toISOString(),
            backedUpTo: enabledBackups.map((b) => b.title),
            routedToChannel: routedChannelLabel || undefined,
          };
          addBotLog(
            'USERBOT_MTPROTO',
            primaryChat,
            `Delivered FULL single video ${job.title} (${sizeMb.toFixed(2)} MB) to ${allDestChatIds.length} destination(s) via 2GB Userbot.`
          );
        } else {
          // Automatic fallback to split parts only if Userbot encountered an error
          const parts = await splitMp4IntoFastPartsIfNeeded(job.filePath);
          job.status = 'uploading_bot_api';
          for (let idx = 0; idx < parts.length; idx++) {
            const pPath = parts[idx];
            const pMeta = await probeVideoMetadataAndThumb(pPath, `${job.id}_p${idx}`);
            const pSizeMb = (fs.statSync(pPath).size / (1024 * 1024)).toFixed(1);
            const partCaption = `🎬 ${job.title} [Part ${idx + 1}/${parts.length}]\n${folderLine}${resLine}📦 Size: ${pSizeMb} MB`;
            const partRes = await uploadToTelegramBotApi(pPath, primaryChat, partCaption, pMeta);
            if (partRes.ok && partRes.messageId && partRes.fromChatId && secondaryChatIds.length > 0) {
              for (const destId of secondaryChatIds) {
                await copyTelegramVideoMessage(
                  partRes.fromChatId,
                  partRes.messageId,
                  destId,
                  partCaption
                );
              }
            }
          }
          job.telegramResult = {
            deliveredVia: 'BOT_API_50MB',
            chatId: primaryChat,
            fileSizeMb: sizeMb.toFixed(2),
            timestamp: new Date().toISOString(),
            backedUpTo: enabledBackups.map((b) => b.title),
            routedToChannel: routedChannelLabel || undefined,
          };
        }
      } else {
        // CASE C: Split Mode explicitly chosen or Userbot not configured
        const parts = await splitMp4IntoFastPartsIfNeeded(job.filePath);
        job.status = 'uploading_bot_api';
        await updateTelegramProgressIfNeeded(
          `🚀 Uploading ${parts.length} parts (${sizeMb.toFixed(1)} MB total) to Telegram & Backup Channels...`,
          true
        );
        for (let idx = 0; idx < parts.length; idx++) {
          const pPath = parts[idx];
          const pMeta = await probeVideoMetadataAndThumb(pPath, `${job.id}_p${idx}`);
          const pSizeMb = (fs.statSync(pPath).size / (1024 * 1024)).toFixed(1);
          const partCaption = `🎬 ${job.title} [Part ${idx + 1}/${parts.length}]\n${folderLine}${resLine}📦 Size: ${pSizeMb} MB`;
          const upRes = await uploadToTelegramBotApi(pPath, primaryChat, partCaption, pMeta);
          if (!upRes.ok) {
            throw new Error(upRes.error || `Part ${idx + 1} failed to upload`);
          }
          if (upRes.messageId && upRes.fromChatId && secondaryChatIds.length > 0) {
            for (const destId of secondaryChatIds) {
              await copyTelegramVideoMessage(upRes.fromChatId, upRes.messageId, destId, partCaption);
            }
          }
        }
        job.telegramResult = {
          deliveredVia: 'BOT_API_50MB',
          chatId: primaryChat,
          fileSizeMb: sizeMb.toFixed(2),
          timestamp: new Date().toISOString(),
          backedUpTo: enabledBackups.map((b) => b.title),
          routedToChannel: routedChannelLabel || undefined,
        };
      }

      const totalElapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      const backupSummary =
        enabledBackups.length > 0
          ? `\n🛡️ Saved in Backup: ${enabledBackups.map((b) => b.title).join(', ')}`
          : '';
      const routeSummary = routedChannelId
        ? `\n🎯 Sent to Channel: ${routedChannelLabel || routedChannelId}`
        : '';
      await updateTelegramProgressIfNeeded(
        `✅ Full Video Sent in ${totalElapsedSec}s: ${job.title} (${sizeMb.toFixed(2)} MB)${routeSummary}${backupSummary}`,
        true
      );
    }

    job.progressPercent = 100;
    job.status = 'completed';
  } catch (err: any) {
    job.status = 'failed';
    job.error = err?.message || 'Unexpected error during stream download';
    addBotLog('SYSTEM', job.telegramChatId || 'local', `Job failed (${job.title}): ${job.error}`);
    await updateTelegramProgressIfNeeded(`❌ Download Failed (${job.title}): ${job.error}`, true);
  } finally {
    cleanupJobTempFiles(job.id);
    job.fileReadyForBrowser = false;
  }
}

// Per-chat worker so multiple authorized Telegram accounts can download simultaneously without blocking each other!
async function runChatSequentialWorker(chatId: string) {
  if (activeChatWorkers.has(chatId)) return;
  activeChatWorkers.add(chatId);
  try {
    const queue = chatJobQueues.get(chatId) || [];
    while (queue.length > 0) {
      const nextJob = queue.shift();
      if (!nextJob) break;
      if (nextJob.status !== 'queued') continue;
      await processDownloadJob(nextJob);
    }
  } finally {
    activeChatWorkers.delete(chatId);
  }
}

function enqueueJobForChat(chatId: string, job: DownloadJob) {
  let queue = chatJobQueues.get(chatId);
  if (!queue) {
    queue = [];
    chatJobQueues.set(chatId, queue);
  }
  queue.push(job);
  runChatSequentialWorker(chatId);
}

// ============================================================================
// BACKGROUND TELEGRAM BOT LONG-POLLING ENGINE + AUTO-CHANNEL BACKUP + ROUTING
// ============================================================================

let botPollingOffset = 0;
let botPollingActive = false;

async function pollTelegramBotUpdates() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    botPollingActive = false;
    botInfoCache = { connected: false };
    setTimeout(pollTelegramBotUpdates, 5000);
    return;
  }

  // If user handed over polling to their 24/7 Hugging Face Space, pause local getUpdates to avoid 409 Conflict
  if (!IS_RUNNING_ON_HF && botSettings.hfCloud?.localPollingPaused) {
    botPollingActive = false;
    setTimeout(pollTelegramBotUpdates, 4000);
    return;
  }

  try {
    if (!botInfoCache.connected) {
      const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const meData = (await meRes.json()) as any;
      if (meData.ok && meData.result) {
        botInfoCache = {
          connected: true,
          username: meData.result.username,
          firstName: meData.result.first_name,
        };
        botPollingActive = true;
        addBotLog('SYSTEM', 'bot', `Connected to Telegram Bot @${meData.result.username}`);
        await registerTelegramBotMenu(token);
      } else {
        botInfoCache = {
          connected: false,
          error: meData.description || 'Invalid TELEGRAM_BOT_TOKEN',
        };
        setTimeout(pollTelegramBotUpdates, 8000);
        return;
      }
    }

    botPollingActive = true;
    const updatesRes = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?offset=${botPollingOffset}&timeout=10`
    );
    const updatesData = (await updatesRes.json()) as any;

    if (!updatesData.ok && updatesData.error_code === 409 && !IS_RUNNING_ON_HF) {
      // Another instance (e.g., Hugging Face 24/7 Space) is actively polling this bot!
      addBotLog(
        'SYSTEM',
        'bot',
        'Detected 24/7 Cloud Bot instance polling (409 Handover). Local polling paused automatically to prevent conflict.'
      );
      botSettings.hfCloud.localPollingPaused = true;
      botPollingActive = false;
      saveBotSettings();
      setTimeout(pollTelegramBotUpdates, 5000);
      return;
    }

    if (updatesData.ok && Array.isArray(updatesData.result)) {
      for (const update of updatesData.result) {
        botPollingOffset = update.update_id + 1;

        // 0A. Handle Inline Menu Button Callbacks (from /features menu)
        if (update.callback_query) {
          const cb = update.callback_query;
          const cbId = cb.id;
          const cbData = String(cb.data || '');
          const cbChatId = String(cb.message?.chat?.id || cb.from?.id || '');
          const cbSenderId = String(cb.from?.id || cbChatId);
          const cbMsgId = cb.message?.message_id;

          if (!cbChatId) {
            await answerTelegramCallbackQuery(cbId);
            continue;
          }

          if (!isChatAuthorized(cbChatId) && !isChatAuthorized(cbSenderId)) {
            await answerTelegramCallbackQuery(
              cbId,
              '🔒 Access Locked! Send Unique Activation Code first.'
            );
            continue;
          }

          if (cbData.startsWith('feat:q:')) {
            const newQ = cbData.replace('feat:q:', '').trim().toLowerCase();
            if (['144p', '240p', '360p', '480p', '720p', '1080p'].includes(newQ)) {
              botSettings.globalDefaultQuality = newQ;
              saveBotSettings();
              addBotLog('SYSTEM', cbChatId, `Changed Default Video Quality via /features menu to ${newQ.toUpperCase()}`);
              await answerTelegramCallbackQuery(cbId, `✅ Default Quality set to ${newQ.toUpperCase()}`);
              const menu = buildFeaturesMenuPayload(cbChatId, cbSenderId);
              await editTelegramTextMessage(cbChatId, cbMsgId, menu.text, menu.replyMarkup);
            }
            continue;
          }

          if (cbData.startsWith('feat:mode:')) {
            const modeVal = cbData.replace('feat:mode:', '').trim();
            botSettings.preferFullSingleVideo = modeVal === 'full';
            saveBotSettings();
            const label = botSettings.preferFullSingleVideo
              ? 'Full Single Video (Puri Video up to 2GB)'
              : 'Fast Split Parts (<48MB)';
            addBotLog('SYSTEM', cbChatId, `Changed Delivery Mode via /features menu to ${label}`);
            await answerTelegramCallbackQuery(cbId, `✅ Mode: ${label}`);
            const menu = buildFeaturesMenuPayload(cbChatId, cbSenderId);
            await editTelegramTextMessage(cbChatId, cbMsgId, menu.text, menu.replyMarkup);
            continue;
          }

          if (cbData === 'feat:refresh') {
            await answerTelegramCallbackQuery(cbId, '🔄 Menu Refreshed!');
            const menu = buildFeaturesMenuPayload(cbChatId, cbSenderId);
            await editTelegramTextMessage(cbChatId, cbMsgId, menu.text, menu.replyMarkup);
            continue;
          }

          if (cbData === 'feat:view:channels') {
            await answerTelegramCallbackQuery(cbId, '🛡️ Opening Backup Channels & Rules');
            const bList =
              botSettings.backupChannels.length > 0
                ? botSettings.backupChannels
                    .map((b, i) => `${i + 1}. ${b.enabled ? '🟢' : '⚪'} ${b.title} (${b.chatId})`)
                    .join('\n')
                : 'No Backup Channels added yet.';
            const rList =
              botSettings.routeRules.length > 0
                ? botSettings.routeRules
                    .map(
                      (r, i) =>
                        `${i + 1}. ${r.enabled ? '🎯' : '⚪'} "${r.pattern}" -> ${r.targetTitle} (${r.targetChatId})`
                    )
                    .join('\n')
                : 'No Fix-Link Rules added yet.';
            await sendTelegramTextMessage(
              cbChatId,
              `🛡️ Backup Channels / Groups (All Videos Saved Here):\n${bList}\n\n` +
                `🎯 Fix Link -> Fix Channel Rules:\n${rList}\n\n` +
                `💡 Tip: Apne Channel se koi bhi message yahan Forward karein ya Bot ko Channel me Admin banayein!`
            );
            continue;
          }

          if (cbData === 'feat:help:addbackup') {
            await answerTelegramCallbackQuery(cbId, '➕ How to Add Backup Channel');
            await sendTelegramTextMessage(
              cbChatId,
              `➕ Backup Channel / Group Add Karne Ke 3 Tarike:\n\n` +
                `1️⃣ Automatic: @${botInfoCache.username || 'bot'} ko apne Channel ya Group me Admin add karein — bot turant auto-save chalu kar dega!\n` +
                `2️⃣ Forward Method: Apne Channel ki koi bhi post is bot ko Forward karein.\n` +
                `3️⃣ Command Method: Send karein:\n` +
                `/addbackup -1001234567890 My Backup Vault`
            );
            continue;
          }

          if (cbData === 'feat:help:route') {
            await answerTelegramCallbackQuery(cbId, '🎯 Fix Link -> Fix Channel Guide');
            await sendTelegramTextMessage(
              cbChatId,
              `🎯 Fix Link -> Fix Channel Feature:\n\n` +
                `Kisi specific website/course/subject ki videos ko kisi fix channel me bhejne ke 2 tarike:\n\n` +
                `1️⃣ Permanent Rule Set Karein:\n` +
                `/route subjectid=1677 -100192837465 RWA Maths Channel\n\n` +
                `2️⃣ One-Time Link Ke Sath Channel ID Bhejein:\n` +
                `https://studybeepro.site/rwax/topic.html?courseid=284&subjectid=1677&domainId=RWA -> -100192837465`
            );
            continue;
          }

          if (cbData === 'feat:help:course') {
            await answerTelegramCallbackQuery(cbId, '📂 Multi-Folder Course Guide');
            await sendTelegramTextMessage(
              cbChatId,
              `📂 Deep Multi-Folder & Course Video Extractor:\n\n` +
                `• Aap koi bhi Course/Topic link (e.g. StudyBee / RWA / HLS .m3u8 / JS Player page) seedha bot me bhej sakte hain.\n` +
                `• Bot khud saare nested folders aur topics scan karke ek-ek video (${botSettings.globalDefaultQuality.toUpperCase()} default quality) download karega.\n` +
                `• Agar kisi single link ke liye alag quality chahiye to link ke aage likhein:\n` +
                `<link> 480p  ya  <link> 1080p`
            );
            continue;
          }

          if (cbData === 'feat:view:queue') {
            await answerTelegramCallbackQuery(cbId, '📊 Checking Queue');
            const userQueue = chatJobQueues.get(cbChatId) || [];
            const activeJobs = Array.from(jobs.values()).filter(
              (j) =>
                j.telegramChatId === cbChatId &&
                (j.status === 'downloading' || j.status === 'converting' || j.status === 'uploading')
            );
            const activeLines =
              activeJobs.length > 0
                ? activeJobs
                    .map(
                      (j, i) =>
                        `${i + 1}. ⏳ ${j.title} — ${j.status.toUpperCase()} (${Math.round(j.progress || 0)}%)`
                    )
                    .join('\n')
                : 'No video currently downloading.';
            await sendTelegramTextMessage(
              cbChatId,
              `📊 Your Download Queue Status:\n\n` +
                `⚡ Currently Processing (${activeJobs.length}):\n${activeLines}\n\n` +
                `🕒 Waiting in Queue: ${userQueue.length} video(s)`
            );
            continue;
          }

          if (cbData === 'feat:action:stop') {
            const userQueue = chatJobQueues.get(cbChatId) || [];
            const count = userQueue.length;
            userQueue.length = 0;
            for (const j of jobs.values()) {
              if (j.telegramChatId === cbChatId && j.status === 'queued') {
                j.status = 'failed';
                j.error = 'Cancelled via /features Stop button';
              }
            }
            await answerTelegramCallbackQuery(cbId, `🛑 Cleared ${count} queued video(s)`);
            const menu = buildFeaturesMenuPayload(cbChatId, cbSenderId);
            await editTelegramTextMessage(cbChatId, cbMsgId, menu.text, menu.replyMarkup);
            await sendTelegramTextMessage(
              cbChatId,
              `🛑 Stopped & cleared ${count} pending video(s) from your queue.`
            );
            continue;
          }

          await answerTelegramCallbackQuery(cbId);
          continue;
        }

        // 0B. Auto-detect when Bot is added as Admin/Member to any Channel or Group!
        const memberUpdate = update.my_chat_member;
        if (memberUpdate && memberUpdate.chat && memberUpdate.new_chat_member) {
          const newStatus = memberUpdate.new_chat_member.status;
          const chatObj = memberUpdate.chat;
          if (
            (newStatus === 'administrator' || newStatus === 'member') &&
            (chatObj.type === 'channel' || chatObj.type === 'supergroup' || chatObj.type === 'group')
          ) {
            const cId = String(chatObj.id);
            const cTitle = chatObj.title || `Channel ${cId}`;
            const cType = chatObj.type === 'channel' ? 'channel' : 'group';
            upsertBackupChannel(cId, cTitle, cType, 'bot');
            addBotLog(
              'SYSTEM',
              cId,
              `Auto-registered Backup ${cType.toUpperCase()}: "${cTitle}" (${cId})`
            );
            await sendTelegramTextMessage(
              cId,
              `✅ StreamBridge Auto-Backup Enabled!\n\n` +
                `📌 Name: ${cTitle}\n` +
                `🆔 Chat ID: ${cId}\n` +
                `🛡️ Ab bot se download hone wali saari videos proper Full MP4 format me yahan as a backup save hongi!`
            );
          }
          continue;
        }

        // Also support `/addbackup` or `/id` posted directly inside a Channel
        if (update.channel_post && update.channel_post.chat) {
          const chPost = update.channel_post;
          const cId = String(chPost.chat.id);
          const cTitle = chPost.chat.title || `Channel ${cId}`;
          const postText = (chPost.text || '').trim();
          if (postText.startsWith('/addbackup') || postText.startsWith('/id') || postText.startsWith('/start')) {
            upsertBackupChannel(cId, cTitle, 'channel', 'bot');
            addBotLog('SYSTEM', cId, `Registered Backup Channel via channel post: "${cTitle}" (${cId})`);
            await sendTelegramTextMessage(
              cId,
              `✅ Backup Channel Registered: "${cTitle}" (ID: ${cId})\nSaari downloaded videos yahan automatically save hongi!`
            );
          }
          continue;
        }

        const msg = update.message;
        if (!msg) continue;

        // 1. Handle MTProto Userbot -> Bot -> All Target Chats (User + Fixed Channel + All Backup Channels/Groups) Relay
        const captionText: string = msg.caption || '';
        const relayMatch = captionText.match(/^#RELAY_(-?\d+)_([^#]+)#\n?([\s\S]*)$/);
        if (relayMatch && (msg.video || msg.document)) {
          const fullTag = captionText.match(/^#RELAY_[^#]+#/)?.[0] || '';
          const parsedPrimaryChatId = relayMatch[1];
          const fallbackCaption = relayMatch[3] || '';
          const relayInfo = pendingUserbotRelays.get(fullTag);

          const enabledBackupIds = botSettings.backupChannels
            .filter((b) => b.enabled && b.chatId)
            .map((b) => b.chatId.trim());

          const allTargets =
            relayInfo?.allTargetChatIds && relayInfo.allTargetChatIds.length > 0
              ? relayInfo.allTargetChatIds
              : Array.from(new Set([parsedPrimaryChatId, ...enabledBackupIds].filter(Boolean)));
          const finalCaption = relayInfo?.cleanCaption || fallbackCaption;

          if (relayInfo) {
            pendingUserbotRelays.delete(fullTag);
          }

          for (const destChatId of allTargets) {
            await copyTelegramVideoMessage(msg.chat.id, msg.message_id, destChatId, finalCaption);
          }

          if (relayInfo) {
            relayInfo.resolve({ fromChatId: String(msg.chat.id), messageId: msg.message_id });
          }
          continue;
        }

        const chatId = String(msg.chat.id);
        const chatType = msg.chat.type; // 'private' | 'group' | 'supergroup'
        const firstName =
          [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Telegram User';
        const username = msg.from?.username;

        // 2. If user forwards a message from a Channel to the Bot, auto-add that Channel to Backup Channels!
        if (msg.forward_from_chat && (msg.forward_from_chat.type === 'channel' || msg.forward_from_chat.type === 'supergroup')) {
          if (isChatAuthorized(chatId)) {
            const fwdChat = msg.forward_from_chat;
            const fwdId = String(fwdChat.id);
            const fwdTitle = fwdChat.title || `Channel ${fwdId}`;
            const fwdType = fwdChat.type === 'channel' ? 'channel' : 'group';
            upsertBackupChannel(fwdId, fwdTitle, fwdType, 'bot');
            addBotLog('SYSTEM', chatId, `Added Backup ${fwdType} via forwarded message: "${fwdTitle}" (${fwdId})`);
            await sendTelegramTextMessage(
              chatId,
              `✅ Backup Channel/Group Added Successfully!\n\n` +
                `📢 Name: ${fwdTitle}\n` +
                `🆔 Channel ID: ${fwdId}\n\n` +
                `🛡️ Make sure @${botInfoCache.username || 'bot'} is an Admin in "${fwdTitle}". Ab har downloaded video automatically is channel me bhi save hogi!\n\n` +
                `🎯 Tip: Kisi fix link ko is channel me bhejne ke liye send karein:\n` +
                `/route <course_link_ya_keyword> ${fwdId}`
            );
            continue;
          }
        }

        if (!msg.text) continue;

        const text = msg.text.trim();
        const baseCmd = text.split(/\s+/)[0].split('@')[0].toLowerCase();
        addBotLog('INCOMING', chatId, `${firstName}: ${text}`);

        const currentCodeState = ensureValidAccessCode();

        // 3. Check if user is sending the Unique Bot Activation Code (e.g., "SB-4829-X7K")
        const cleanInputCode = text.replace(/^\/?(code|activate|login)\s+/i, '').trim().toUpperCase();
        if (cleanInputCode === currentCodeState.code.toUpperCase()) {
          const durationMs = DURATION_MAP[currentCodeState.durationKey]?.ms || DURATION_MAP['24h'].ms;
          const durationLabel =
            DURATION_MAP[currentCodeState.durationKey]?.label || DURATION_MAP['24h'].label;
          const now = Date.now();
          const expiresAt = new Date(now + durationMs).toISOString();

          botSettings.authorizedUsers[chatId] = {
            chatId,
            firstName,
            username,
            activatedWithCode: currentCodeState.code,
            activatedAt: new Date(now).toISOString(),
            expiresAt,
          };
          saveBotSettings();
          addBotLog(
            'SYSTEM',
            chatId,
            `Authorized user ${firstName} (${chatId}) with code ${currentCodeState.code} for ${durationLabel}`
          );

          const menu = buildFeaturesMenuPayload(chatId);
          await sendTelegramTextMessage(
            chatId,
            `✅ Access Granted! (${firstName}) is now activated for ${durationLabel}.\n\n` +
              menu.text,
            menu.replyMarkup
          );
          continue;
        }

        // If inside a group and someone types /addbackup, allow registering the group if sender or group is authorized
        if ((chatType === 'group' || chatType === 'supergroup') && baseCmd === '/addbackup') {
          const grpTitle = msg.chat.title || `Backup Group ${chatId}`;
          upsertBackupChannel(chatId, grpTitle, 'group', 'bot');
          await sendTelegramTextMessage(
            chatId,
            `✅ Backup Group Registered: "${grpTitle}" (ID: ${chatId})\nAb bot se download hone wali saari videos is group me bhi save hongi!`
          );
          continue;
        }

        // 4. Enforce Access Code Gate
        const senderId = String(msg.from?.id || chatId);
        if (!isChatAuthorized(chatId) && !isChatAuthorized(senderId)) {
          await sendTelegramTextMessage(
            chatId,
            `🔒 Bot Access Locked!\n\n` +
              `Bot ko activate karne ke liye Web Control Dashboard se "Unique Bot Activation Code" (e.g. ${currentCodeState.code.slice(0, 3)}XXXX-XXX) copy karein aur yahan send karein.`
          );
          addBotLog('SYSTEM', chatId, `Blocked unauthorized message from ${firstName} (${chatId}).`);
          continue;
        }

        // 5. All Features Interactive Menu (/features, /menu, /start, /help, /status)
        if (
          baseCmd === '/features' ||
          baseCmd === '/menu' ||
          baseCmd === '/start' ||
          baseCmd === '/help' ||
          baseCmd === '/status'
        ) {
          const menu = buildFeaturesMenuPayload(chatId, senderId);
          await sendTelegramTextMessage(chatId, menu.text, menu.replyMarkup);
          continue;
        }

        // 6. Direct Quality Command (/quality or /quality 720p)
        if (baseCmd === '/quality') {
          const argQ = text.replace(/^\/quality(@\S+)?\s*/i, '').trim().toLowerCase();
          if (['144p', '240p', '360p', '480p', '720p', '1080p'].includes(argQ)) {
            botSettings.globalDefaultQuality = argQ;
            saveBotSettings();
            await sendTelegramTextMessage(
              chatId,
              `✅ Default Video Quality updated to ${argQ.toUpperCase()}!`
            );
          } else {
            const menu = buildFeaturesMenuPayload(chatId, senderId);
            await sendTelegramTextMessage(
              chatId,
              `🎞 Current Default Quality: ${botSettings.globalDefaultQuality.toUpperCase()}\nNeeche button daba kar quality select karein:`,
              menu.replyMarkup
            );
          }
          continue;
        }

        // 7. Direct Delivery Mode Command (/mode)
        if (baseCmd === '/mode') {
          botSettings.preferFullSingleVideo = !botSettings.preferFullSingleVideo;
          saveBotSettings();
          const modeLabel = botSettings.preferFullSingleVideo
            ? 'Full Single Video (Puri Video up to 2GB via Userbot)'
            : 'Fast Split Parts (<48MB via Bot API)';
          const menu = buildFeaturesMenuPayload(chatId, senderId);
          await sendTelegramTextMessage(
            chatId,
            `🎬 Video Delivery Mode switched to:\n👉 ${modeLabel}`,
            menu.replyMarkup
          );
          continue;
        }

        // 8. Queue Status Command (/queue)
        if (baseCmd === '/queue') {
          const userQueue = chatJobQueues.get(chatId) || [];
          const activeJobs = Array.from(jobs.values()).filter(
            (j) =>
              j.telegramChatId === chatId &&
              (j.status === 'downloading' || j.status === 'converting' || j.status === 'uploading')
          );
          const activeLines =
            activeJobs.length > 0
              ? activeJobs
                  .map(
                    (j, i) =>
                      `${i + 1}. ⏳ ${j.title} — ${j.status.toUpperCase()} (${Math.round(j.progress || 0)}%)`
                  )
                  .join('\n')
              : 'No video currently downloading.';
          await sendTelegramTextMessage(
            chatId,
            `📊 Your Download Queue Status:\n\n` +
              `⚡ Currently Processing (${activeJobs.length}):\n${activeLines}\n\n` +
              `🕒 Waiting in Queue: ${userQueue.length} video(s)`
          );
          continue;
        }

        // 9. Channel & Backup Commands in Bot
        if (baseCmd === '/addbackup') {
          const parts = text.replace(/^\/addbackup(@\S+)?\s*/i, '').trim().split(/\s+/);
          const targetId = parts[0];
          const label = parts.slice(1).join(' ') || `Backup Channel ${targetId}`;
          if (!targetId) {
            await sendTelegramTextMessage(
              chatId,
              `ℹ️ Backup Channel/Group add karne ke 3 aasan tarike:\n\n` +
                `1️⃣ Bot (@${botInfoCache.username}) ko apne Channel ya Group me Admin banayein (Bot khud auto-detect kar lega!)\n` +
                `2️⃣ Apne Channel ki koi bhi post is bot ko Forward karein\n` +
                `3️⃣ Ya command bhejein: /addbackup -1001234567890 My Backup Channel`
            );
            continue;
          }
          const created = upsertBackupChannel(
            targetId,
            label,
            targetId.startsWith('-100') ? 'channel' : 'group',
            'bot'
          );
          await sendTelegramTextMessage(
            chatId,
            `✅ Backup Channel/Group Added: "${created.title}" (${created.chatId})\nAb har video automatically yahan bhi save hogi!`
          );
          continue;
        }

        if (baseCmd === '/route') {
          const args = text.replace(/^\/route(@\S+)?\s*/i, '').trim().split(/\s+/);
          if (args.length < 2) {
            await sendTelegramTextMessage(
              chatId,
              `🎯 Fix Link -> Fix Channel Rule kaise lagayein:\n\n` +
                `Command format:\n` +
                `/route <link_ya_courseid> <channel_id> [Channel Name]\n\n` +
                `Example:\n` +
                `/route subjectid=1677 -100192837465 RWA Maths Channel\n\n` +
                `Ya direct link bhejte waqt aise likhein:\n` +
                `https://studybeepro.site/rwax/topic.html?courseid=284&subjectid=1677&domainId=RWA -> -100192837465`
            );
            continue;
          }
          const pattern = args[0];
          const targetChannelId = args[1];
          const label = args.slice(2).join(' ') || `Route -> ${targetChannelId}`;
          const newRule: ChannelRouteRule = {
            id: crypto.randomUUID(),
            pattern,
            label,
            targetChatId: targetChannelId,
            targetTitle: label,
            enabled: true,
            createdAt: new Date().toISOString(),
          };
          botSettings.routeRules.push(newRule);
          saveBotSettings();
          await sendTelegramTextMessage(
            chatId,
            `✅ Fix Link -> Fix Channel Rule Saved!\n\n` +
              `🔗 Link Match: ${pattern}\n` +
              `🎯 Target Channel: ${label} (${targetChannelId})\n` +
              `🛡️ Plus Backup Channels me bhi save hogi!`
          );
          continue;
        }

        if (baseCmd === '/channels' || baseCmd === '/backups') {
          const bList =
            botSettings.backupChannels.length > 0
              ? botSettings.backupChannels
                  .map(
                    (b, i) =>
                      `${i + 1}. ${b.enabled ? '🟢' : '⚪'} ${b.title} (${b.chatId})`
                  )
                  .join('\n')
              : 'No Backup Channels added yet.';
          const rList =
            botSettings.routeRules.length > 0
              ? botSettings.routeRules
                  .map(
                    (r, i) =>
                      `${i + 1}. ${r.enabled ? '🎯' : '⚪'} "${r.pattern}" -> ${r.targetTitle} (${r.targetChatId})`
                  )
                  .join('\n')
              : 'No Fix-Link Rules added yet.';
          await sendTelegramTextMessage(
            chatId,
            `🛡️ Backup Channels / Groups (All Videos Saved Here):\n${bList}\n\n` +
              `🎯 Fix Link -> Fix Channel Rules:\n${rList}\n\n` +
              `💡 Add more from the Web Dashboard or forward any Channel post here!`
          );
          continue;
        }

        if (baseCmd === '/stop') {
          const userQueue = chatJobQueues.get(chatId) || [];
          const count = userQueue.length;
          userQueue.length = 0;
          for (const j of jobs.values()) {
            if (j.telegramChatId === chatId && j.status === 'queued') {
              j.status = 'failed';
              j.error = 'Cancelled by user /stop command';
            }
          }
          await sendTelegramTextMessage(
            chatId,
            `🛑 Stopped & cleared ${count} pending video(s) from your queue.`
          );
          continue;
        }

        const urlMatch = text.match(/https?:\/\/[^\s]+/i);
        if (urlMatch) {
          const targetUrl = urlMatch[0];
          const qualityMatch = text.match(/\b(144p|240p|360p|480p|720p|1080p)\b/i);
          const preferredQuality = qualityMatch
            ? qualityMatch[1].toLowerCase()
            : botSettings.globalDefaultQuality || '720p';

          // Check if user specified inline target channel like: `https://... -> -100123456789` or `to:-100123456789`
          const inlineChannelMatch =
            text.match(/(?:->|=>|\bto:)\s*(-100\d+|-\d+|@[a-zA-Z0-9_]+)/i);
          const explicitTargetChannelId = inlineChannelMatch ? inlineChannelMatch[1].trim() : undefined;
          const matchedRule = findMatchingRouteRule(targetUrl);
          const activeRouteLabel =
            explicitTargetChannelId || matchedRule?.targetTitle || matchedRule?.targetChatId;

          const statusMsgId = await sendTelegramTextMessage(
            chatId,
            `⚡ Turbo Engine: Scanning folders & videos (Quality: ${preferredQuality.toUpperCase()})...\n` +
              (activeRouteLabel ? `🎯 Routing to Channel: ${activeRouteLabel}\n` : '') +
              `${targetUrl}`
          );

          try {
            const extracted = await inspectUrlAndExtractStreams(targetUrl, undefined, undefined, true);
            if (extracted.streams.length === 0) {
              await editTelegramTextMessage(
                chatId,
                statusMsgId,
                `❌ No playable .m3u8 or .mp4 streams found on that URL.`
              );
            } else if (extracted.streams.length > 1) {
              await editTelegramTextMessage(
                chatId,
                statusMsgId,
                `📁 Found ${extracted.streams.length} videos across ${
                  extracted.folders.length || 1
                } folder(s) in "${extracted.pageTitle}"!\n` +
                  `🎞 Quality: ${preferredQuality.toUpperCase()} (Full Complete MP4)\n` +
                  (activeRouteLabel ? `🎯 Target Channel: ${activeRouteLabel}\n` : '') +
                  (botSettings.backupChannels.filter((b) => b.enabled).length > 0
                    ? `🛡️ Auto-Backup: ${
                        botSettings.backupChannels.filter((b) => b.enabled).length
                      } channel/group(s)\n`
                    : '') +
                  `🚀 Downloading & sending all full videos 1-by-1. Send /stop anytime to stop.`
              );

              for (let idx = 0; idx < extracted.streams.length; idx++) {
                const stream = extracted.streams[idx];
                const jobId = crypto.randomUUID();
                const newJob: DownloadJob = {
                  id: jobId,
                  title: `[${idx + 1}/${extracted.streams.length}] ${stream.label}`,
                  folderName: stream.folderName,
                  sourceUrl: stream.url,
                  originalRequestUrl: targetUrl,
                  explicitTargetChannelId,
                  protocol: stream.protocol,
                  preferredQuality,
                  resolution: stream.resolution || preferredQuality,
                  status: 'queued',
                  progressPercent: 0,
                  totalSegments: 1,
                  completedSegments: 0,
                  downloadedBytes: 0,
                  speedBytesPerSec: 0,
                  deliveryMode: 'telegram_auto',
                  telegramChatId: chatId,
                  outputFormat: 'mp4',
                  createdAt: new Date().toISOString(),
                  fileReadyForBrowser: false,
                  cleanupAfterTelegram: true,
                };
                jobs.set(jobId, newJob);
                enqueueJobForChat(chatId, newJob);
              }
            } else {
              const chosen = extracted.streams[0];
              const jobId = crypto.randomUUID();
              const newJob: DownloadJob = {
                id: jobId,
                title: extracted.pageTitle || chosen.label,
                folderName: chosen.folderName,
                sourceUrl: chosen.url,
                originalRequestUrl: targetUrl,
                explicitTargetChannelId,
                protocol: chosen.protocol,
                preferredQuality,
                resolution: chosen.resolution || preferredQuality,
                status: 'queued',
                progressPercent: 0,
                totalSegments: chosen.segmentCount || 1,
                completedSegments: 0,
                downloadedBytes: 0,
                speedBytesPerSec: 0,
                deliveryMode: 'telegram_auto',
                telegramChatId: chatId,
                telegramStatusMsgId: statusMsgId,
                outputFormat: 'mp4',
                createdAt: new Date().toISOString(),
                fileReadyForBrowser: false,
                cleanupAfterTelegram: true,
              };
              jobs.set(jobId, newJob);
              enqueueJobForChat(chatId, newJob);
            }
          } catch (e: any) {
            await editTelegramTextMessage(
              chatId,
              statusMsgId,
              `⚠️ Error extracting URL: ${e?.message || 'Unknown error'}`
            );
          }
        } else {
          await sendTelegramTextMessage(
            chatId,
            `ℹ️ Please send a valid video or course link (starting with http:// or https://), forward a Channel post to add Backup, or send /help.`
          );
        }
      }
    }
  } catch {
    // transient network error
  }

  setTimeout(pollTelegramBotUpdates, 1500);
}

pollTelegramBotUpdates();

// ============================================================================
// EXPRESS SERVER (BOT STATUS, SECURITY, BACKUP CHANNELS & LINK ROUTING ENDPOINTS)
// ============================================================================

// Background 24/7 Keep-Alive Pinger for Hugging Face Space (runs even when web is closed)
function startCloudKeepAliveLoop() {
  setInterval(async () => {
    const targetUrl =
      process.env.HF_SPACE_URL?.trim() || botSettings.hfCloud?.deployedAppUrl?.trim();
    if (targetUrl && botSettings.hfCloud?.autoPingEnabled !== false) {
      try {
        await fetch(`${targetUrl.replace(/\/$/, '')}/api/ping`, {
          headers: { 'User-Agent': 'StreamBridge-24x7-KeepAlive/1.0' },
        });
      } catch {
        // ignore transient network errors
      }
    }
  }, 5 * 60 * 1000); // Every 5 minutes
}
startCloudKeepAliveLoop();

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '10mb' }));

  // Lightweight Keep-Alive Ping endpoint so Hugging Face Space or UptimeRobot stays awake 24/7
  app.get('/api/ping', (_req, res) => {
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      botConnected: botInfoCache.connected,
      isRunningOnHuggingFace: IS_RUNNING_ON_HF,
    });
  });

  // 1-Click Auto-Deploy to Hugging Face Spaces (24/7 Free Cloud Hosting without keeping Web open)
  app.post('/api/hf/deploy', async (req, res) => {
    const hfToken = String(req.body?.hfToken || process.env.HF_TOKEN || '').trim();
    const rawSpaceName = String(req.body?.spaceName || 'streambridge-bot')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'streambridge-bot';

    if (!hfToken || !hfToken.startsWith('hf_')) {
      res.status(400).json({
        ok: false,
        error: 'Valid Hugging Face Write Token (starting with hf_...) is required.',
      });
      return;
    }

    try {
      // Step 1: Verify HF Token & get username
      const whoRes = await fetch('https://huggingface.co/api/whoami-v2', {
        headers: { Authorization: `Bearer ${hfToken}` },
      });
      if (!whoRes.ok) {
        const errText = await whoRes.text();
        res.status(400).json({
          ok: false,
          error: `Hugging Face Token verification failed (${whoRes.status}). Make sure your token has WRITE permissions! Details: ${errText.slice(0, 120)}`,
        });
        return;
      }
      const whoData = (await whoRes.json()) as any;
      const hfUsername = whoData?.name;
      if (!hfUsername) {
        res.status(400).json({ ok: false, error: 'Could not determine Hugging Face username from token.' });
        return;
      }

      const repoId = `${hfUsername}/${rawSpaceName}`;
      const spaceUrl = `https://huggingface.co/spaces/${repoId}`;
      const directAppUrl = `https://${hfUsername.toLowerCase()}-${rawSpaceName.toLowerCase()}.hf.space`;

      addBotLog('SYSTEM', 'hf-cloud', `Starting 1-Click 24/7 Deploy to Hugging Face Space: ${repoId}`);

      // Step 2: Create the Space (try Docker first, then fallback to Free ZeroGPU if 402)
      let createRes = await fetch('https://huggingface.co/api/repos/create', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${hfToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'space',
          name: rawSpaceName,
          sdk: 'docker',
          private: false,
        }),
      });

      if (createRes.status === 402) {
        // Hugging Face requires PRO for Docker on cpu-basic; try Free ZeroGPU tier (works on 30+ day old HF accounts)
        const zeroGpuRes = await fetch('https://huggingface.co/api/repos/create', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${hfToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'space',
            name: rawSpaceName,
            sdk: 'gradio',
            hardware: 'zerogpu',
            private: false,
          }),
        });

        if (!zeroGpuRes.ok && zeroGpuRes.status !== 409) {
          const zeroErrText = await zeroGpuRes.text();
          res.status(400).json({
            ok: false,
            error:
              `Hugging Face Policy Restriction on account "${hfUsername}": ` +
              `Hugging Face ne naye accounts par Docker Spaces ke liye PRO ($9/mo) maangna shuru kar diya hai (Error 402), aur Free ZeroGPU Space ke liye Hugging Face account kam se kam 30 din purana (30 days old) hona zaroori hai (${zeroErrText}). ` +
              `👉 Solution: Ya to 30+ din purana Hugging Face account token use karein, YA neeche "Option B: 1-Click GitHub -> Render.com (100% Free on New Account, No Card)" use karein!`,
          });
          return;
        }
        createRes = zeroGpuRes;
      }

      if (!createRes.ok && createRes.status !== 409) {
        const createErr = await createRes.text();
        res.status(400).json({
          ok: false,
          error: `Failed to create Space (${createRes.status}): ${createErr.slice(0, 200)}`,
        });
        return;
      }

      // Step 3: Upload all Telegram & Userbot Secrets to the Hugging Face Space
      const secretsToPush: Record<string, string> = {
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN?.trim() || '',
        TELEGRAM_API_ID: process.env.TELEGRAM_API_ID?.trim() || '',
        TELEGRAM_API_HASH: process.env.TELEGRAM_API_HASH?.trim() || '',
        TELEGRAM_STRING_SESSION: process.env.TELEGRAM_STRING_SESSION?.trim() || '',
        TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID?.trim() || '',
        HF_SPACE_URL: directAppUrl,
      };

      for (const [secKey, secVal] of Object.entries(secretsToPush)) {
        if (!secVal) continue;
        try {
          await fetch(`https://huggingface.co/api/spaces/${repoId}/secrets`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${hfToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              key: secKey,
              value: secVal,
            }),
          });
        } catch {
          // continue pushing remaining secrets
        }
      }

      // Step 4: Prepare all project files to commit via Hugging Face NDJSON Commit API
      const hfReadme =
        `---\n` +
        `title: StreamBridge 24x7 Bot\n` +
        `emoji: ⚡\n` +
        `colorFrom: indigo\n` +
        `colorTo: emerald\n` +
        `sdk: docker\n` +
        `app_port: 7860\n` +
        `pinned: false\n` +
        `---\n\n` +
        `# StreamBridge 24/7 Telegram Video Downloader Bot & MTProto 2GB Userbot\n\n` +
        `This Space runs the StreamBridge Telegram Bot (\`@${botInfoCache.username || 'bot'}\`) 24/7 in the cloud.\n`;

      const filesToCommit: Array<{ path: string; content: string }> = [
        { path: 'README.md', content: hfReadme },
      ];

      const projectFiles = [
        'Dockerfile',
        'package.json',
        'tsconfig.json',
        'vite.config.ts',
        'index.html',
        'server.ts',
        'src/types.ts',
        'src/App.tsx',
        'src/main.tsx',
        'src/index.css',
      ];

      for (const relPath of projectFiles) {
        const absPath = path.join(process.cwd(), relPath);
        if (fs.existsSync(absPath)) {
          filesToCommit.push({
            path: relPath,
            content: fs.readFileSync(absPath, 'utf8'),
          });
        }
      }

      // Include current bot-config.json with localPollingPaused = false for the remote HF Space
      const remoteConfig: PersistedBotSettings = {
        ...botSettings,
        hfCloud: {
          deployedRepoId: repoId,
          deployedSpaceUrl: spaceUrl,
          deployedAppUrl: directAppUrl,
          lastDeployedAt: new Date().toISOString(),
          autoPingEnabled: true,
          localPollingPaused: false,
        },
      };
      filesToCommit.push({
        path: 'bot-config.json',
        content: JSON.stringify(remoteConfig, null, 2),
      });

      const ndjsonLines: string[] = [
        JSON.stringify({
          key: 'header',
          value: {
            summary: 'Deploy 24/7 StreamBridge Telegram Bot + 2GB Userbot Engine',
          },
        }),
      ];

      for (const f of filesToCommit) {
        ndjsonLines.push(
          JSON.stringify({
            key: 'file',
            value: {
              content: Buffer.from(f.content, 'utf8').toString('base64'),
              path: f.path,
              encoding: 'base64',
            },
          })
        );
      }

      const commitRes = await fetch(`https://huggingface.co/api/spaces/${repoId}/commit/main`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${hfToken}`,
          'Content-Type': 'application/x-ndjson',
        },
        body: ndjsonLines.join('\n'),
      });

      if (!commitRes.ok) {
        const commitErr = await commitRes.text();
        res.status(400).json({
          ok: false,
          error: `Failed to push code to Hugging Face Space (${commitRes.status}): ${commitErr.slice(0, 220)}`,
        });
        return;
      }

      botSettings.hfCloud = {
        deployedRepoId: repoId,
        deployedSpaceUrl: spaceUrl,
        deployedAppUrl: directAppUrl,
        lastDeployedAt: new Date().toISOString(),
        autoPingEnabled: true,
        // Keep local polling active for 90 seconds while HF builds Docker, or let 409 auto-handover!
        localPollingPaused: false,
      };
      saveBotSettings();

      addBotLog(
        'SYSTEM',
        'hf-cloud',
        `Successfully deployed 24/7 Bot to Hugging Face Space: ${spaceUrl} (Auto-handover will trigger once container starts!)`
      );

      res.json({
        ok: true,
        hfCloud: {
          isRunningOnHuggingFace: IS_RUNNING_ON_HF,
          ...botSettings.hfCloud,
        },
      });
    } catch (err: any) {
      res.status(500).json({
        ok: false,
        error: err?.message || 'Unexpected error during Hugging Face deployment',
      });
    }
  });

  // Toggle Local Polling vs Hugging Face 24/7 Cloud Polling
  app.post('/api/hf/toggle-polling', (req, res) => {
    const pauseLocal = Boolean(req.body?.localPollingPaused);
    botSettings.hfCloud.localPollingPaused = pauseLocal;
    if (pauseLocal) {
      botPollingActive = false;
    }
    saveBotSettings();
    addBotLog(
      'SYSTEM',
      'hf-cloud',
      pauseLocal
        ? 'Paused local Telegram polling (24/7 Cloud Server is handling bot updates)'
        : 'Resumed local Telegram polling on this server'
    );
    res.json({
      ok: true,
      hfCloud: {
        isRunningOnHuggingFace: IS_RUNNING_ON_HF,
        ...botSettings.hfCloud,
      },
    });
  });

  // 1-Click GitHub Auto-Push for Render.com (100% Free on Brand-New Accounts, No Credit Card Required!)
  app.post('/api/github/deploy', async (req, res) => {
    const ghToken = String(req.body?.githubToken || '').trim();
    const repoName =
      String(req.body?.repoName || 'streambridge-telegram-bot')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]/g, '-') || 'streambridge-telegram-bot';

    if (!ghToken) {
      res.status(400).json({
        ok: false,
        error: 'Please enter a valid GitHub Personal Access Token (ghp_... or github_pat_...).',
      });
      return;
    }

    try {
      const ghHeaders = {
        Authorization: `Bearer ${ghToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'StreamBridge-AutoDeployer/1.0',
        'Content-Type': 'application/json',
      };

      const userRes = await fetch('https://api.github.com/user', { headers: ghHeaders });
      if (!userRes.ok) {
        res.status(400).json({
          ok: false,
          error: `GitHub Token verification failed (${userRes.status}). Make sure your token has "repo" permission!`,
        });
        return;
      }
      const userData = (await userRes.json()) as any;
      const ghUsername = userData.login;

      // Create Repo if not exists
      await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: ghHeaders,
        body: JSON.stringify({
          name: repoName,
          description: 'StreamBridge 24/7 Telegram Video Downloader Bot & 2GB Userbot',
          private: false,
          auto_init: true,
        }),
      });

      const projectFiles = [
        'Dockerfile',
        'render.yaml',
        'package.json',
        'tsconfig.json',
        'vite.config.ts',
        'index.html',
        'server.ts',
        'src/types.ts',
        'src/App.tsx',
        'src/main.tsx',
        'src/index.css',
      ];

      for (const relPath of projectFiles) {
        const absPath = path.join(process.cwd(), relPath);
        if (!fs.existsSync(absPath)) continue;
        const contentB64 = Buffer.from(fs.readFileSync(absPath, 'utf8'), 'utf8').toString('base64');

        // Check if file exists to get sha
        let existingSha: string | undefined;
        try {
          const checkRes = await fetch(
            `https://api.github.com/repos/${ghUsername}/${repoName}/contents/${relPath}`,
            { headers: ghHeaders }
          );
          if (checkRes.ok) {
            const checkData = (await checkRes.json()) as any;
            existingSha = checkData?.sha;
          }
        } catch {
          // ignore
        }

        await fetch(`https://api.github.com/repos/${ghUsername}/${repoName}/contents/${relPath}`, {
          method: 'PUT',
          headers: ghHeaders,
          body: JSON.stringify({
            message: `Update ${relPath} for 24/7 Bot Deployment`,
            content: contentB64,
            ...(existingSha ? { sha: existingSha } : {}),
          }),
        });
      }

      const repoUrl = `https://github.com/${ghUsername}/${repoName}`;
      const renderDeployUrl = `https://render.com/deploy?repo=${encodeURIComponent(repoUrl)}`;

      addBotLog('SYSTEM', 'gh-cloud', `Pushed 24/7 Bot repository to GitHub: ${repoUrl}`);
      res.json({
        ok: true,
        repoUrl,
        renderDeployUrl,
      });
    } catch (err: any) {
      res.status(500).json({
        ok: false,
        error: err?.message || 'Error pushing code to GitHub',
      });
    }
  });

  app.get('/api/download/jobs', (_req, res) => {
    const list = Array.from(jobs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    res.json({ jobs: list });
  });

  app.post('/api/download/clear-finished', (_req, res) => {
    let removedCount = 0;
    for (const [id, job] of jobs.entries()) {
      if (job.status === 'completed' || job.status === 'failed') {
        cleanupJobTempFiles(id);
        jobs.delete(id);
        removedCount++;
      }
    }
    const remaining = Array.from(jobs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    res.json({ removedCount, jobs: remaining });
  });

  // Generate a new Unique Bot Access Code with fixed duration (24h, 48h, 7d, 30d)
  app.post('/api/security/generate-code', (req, res) => {
    const rawDuration = String(req.body?.durationKey || '24h') as AccessDurationKey;
    const validDuration: AccessDurationKey = DURATION_MAP[rawDuration] ? rawDuration : '24h';
    botSettings.accessCode = createFreshAccessCode(validDuration);
    saveBotSettings();
    addBotLog(
      'SYSTEM',
      'web-admin',
      `Generated new Bot Access Code ${botSettings.accessCode.code} (${botSettings.accessCode.durationLabel})`
    );
    res.json({
      ok: true,
      accessCode: botSettings.accessCode,
    });
  });

  // Revoke an authorized Telegram user session
  app.post('/api/security/revoke-user', (req, res) => {
    const chatId = String(req.body?.chatId || '').trim();
    if (chatId && botSettings.authorizedUsers[chatId]) {
      delete botSettings.authorizedUsers[chatId];
      saveBotSettings();
      addBotLog('SYSTEM', 'web-admin', `Revoked bot access for Chat ID ${chatId}`);
    }
    res.json({
      ok: true,
      authorizedUsers: Object.values(botSettings.authorizedUsers),
    });
  });

  // Update Global Default Video Quality (144p, 240p, 360p, 480p, 720p, 1080p)
  app.post('/api/settings/quality', (req, res) => {
    const rawQuality = String(req.body?.quality || '720p').toLowerCase() as VideoQualityOption;
    const allowed: VideoQualityOption[] = ['144p', '240p', '360p', '480p', '720p', '1080p'];
    const validQuality: VideoQualityOption = allowed.includes(rawQuality) ? rawQuality : '720p';
    botSettings.globalDefaultQuality = validQuality;
    saveBotSettings();
    addBotLog(
      'SYSTEM',
      'web-admin',
      `Updated Global Default Video Quality to ${validQuality.toUpperCase()}`
    );
    res.json({
      ok: true,
      globalDefaultQuality: botSettings.globalDefaultQuality,
    });
  });

  // Toggle Full Single Video (Puri Video) Mode vs Split Mode
  app.post('/api/settings/video-mode', (req, res) => {
    botSettings.preferFullSingleVideo = Boolean(req.body?.preferFullSingleVideo);
    saveBotSettings();
    addBotLog(
      'SYSTEM',
      'web-admin',
      `Updated Video Delivery Mode to: ${
        botSettings.preferFullSingleVideo ? 'Full Single Video (Puri Video up to 2GB)' : 'Fast Split Parts (<48MB)'
      }`
    );
    res.json({
      ok: true,
      preferFullSingleVideo: botSettings.preferFullSingleVideo,
    });
  });

  // Add a Backup Channel or Group
  app.post('/api/channels/backup/add', (req, res) => {
    const chatId = String(req.body?.chatId || '').trim();
    const title = String(req.body?.title || chatId).trim();
    const type = req.body?.type === 'group' ? 'group' : 'channel';
    if (!chatId) {
      res.status(400).json({ ok: false, error: 'Channel/Group Chat ID is required' });
      return;
    }
    const created = upsertBackupChannel(chatId, title, type, 'web');
    addBotLog('SYSTEM', 'web-admin', `Added Backup ${type}: "${created.title}" (${created.chatId})`);
    res.json({ ok: true, backupChannels: botSettings.backupChannels });
  });

  // Toggle a Backup Channel or Group
  app.post('/api/channels/backup/toggle', (req, res) => {
    const id = String(req.body?.id || '').trim();
    const item = botSettings.backupChannels.find((b) => b.id === id);
    if (item) {
      item.enabled = !item.enabled;
      saveBotSettings();
    }
    res.json({ ok: true, backupChannels: botSettings.backupChannels });
  });

  // Delete a Backup Channel or Group
  app.post('/api/channels/backup/delete', (req, res) => {
    const id = String(req.body?.id || '').trim();
    botSettings.backupChannels = botSettings.backupChannels.filter((b) => b.id !== id);
    saveBotSettings();
    res.json({ ok: true, backupChannels: botSettings.backupChannels });
  });

  // Test sending a message to a Backup Channel or Group
  app.post('/api/channels/backup/test', async (req, res) => {
    const chatId = String(req.body?.chatId || '').trim();
    if (!chatId) {
      res.status(400).json({ ok: false, error: 'chatId required' });
      return;
    }
    const msgId = await sendTelegramTextMessage(
      chatId,
      `✅ StreamBridge Backup Channel Test Successful!\n🛡️ Saari downloaded videos is channel/group me proper Full MP4 format me save hongi.`
    );
    if (msgId) {
      res.json({ ok: true, messageId: msgId });
    } else {
      res.status(400).json({
        ok: false,
        error: `Could not send message to ${chatId}. Make sure @${
          botInfoCache.username || 'bot'
        } is added as an Admin in that Channel/Group!`,
      });
    }
  });

  // Add a Fix Link -> Fix Channel Route Rule
  app.post('/api/channels/routes/add', (req, res) => {
    const pattern = String(req.body?.pattern || '').trim();
    const targetChatId = String(req.body?.targetChatId || '').trim();
    const targetTitle = String(req.body?.targetTitle || targetChatId).trim();
    const label = String(req.body?.label || targetTitle).trim();
    if (!pattern || !targetChatId) {
      res.status(400).json({ ok: false, error: 'Both Link Pattern and Target Channel ID are required' });
      return;
    }
    const newRule: ChannelRouteRule = {
      id: crypto.randomUUID(),
      pattern,
      label,
      targetChatId,
      targetTitle,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    botSettings.routeRules.push(newRule);
    saveBotSettings();
    addBotLog(
      'SYSTEM',
      'web-admin',
      `Added Link Route Rule: "${pattern}" -> ${targetTitle} (${targetChatId})`
    );
    res.json({ ok: true, routeRules: botSettings.routeRules });
  });

  // Toggle a Fix Link -> Fix Channel Route Rule
  app.post('/api/channels/routes/toggle', (req, res) => {
    const id = String(req.body?.id || '').trim();
    const rule = botSettings.routeRules.find((r) => r.id === id);
    if (rule) {
      rule.enabled = !rule.enabled;
      saveBotSettings();
    }
    res.json({ ok: true, routeRules: botSettings.routeRules });
  });

  // Delete a Fix Link -> Fix Channel Route Rule
  app.post('/api/channels/routes/delete', (req, res) => {
    const id = String(req.body?.id || '').trim();
    botSettings.routeRules = botSettings.routeRules.filter((r) => r.id !== id);
    saveBotSettings();
    res.json({ ok: true, routeRules: botSettings.routeRules });
  });

  app.get('/api/telegram/status', async (_req, res) => {
    const hasToken = Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
    const hasApiId = Boolean(process.env.TELEGRAM_API_ID?.trim());
    const hasApiHash = Boolean(process.env.TELEGRAM_API_HASH?.trim());
    const hasStringSession = Boolean(process.env.TELEGRAM_STRING_SESSION?.trim());

    let userbotConnected = false;
    let userbotAccountName: string | undefined;
    let userbotUsername: string | undefined;
    let userbotError: string | undefined;

    if (hasApiId && hasApiHash && hasStringSession) {
      try {
        const client = await getConnectedUserbotClient();
        if (client) {
          const me = (await client.getMe()) as any;
          if (me) {
            userbotConnected = true;
            userbotAccountName =
              [me.firstName, me.lastName].filter(Boolean).join(' ') || 'MTProto Userbot';
            userbotUsername = me.username;
          }
        }
      } catch (e: any) {
        userbotError = e?.message || 'Failed to connect MTProto StringSession';
      }
    }

    const activeCode = ensureValidAccessCode();

    res.json({
      botApi: {
        hasToken,
        connected: botInfoCache.connected,
        username: botInfoCache.username,
        firstName: botInfoCache.firstName,
        maxSizeMb: 50,
        pollingActive: botPollingActive,
        error: botInfoCache.error,
      },
      userbotMtproto: {
        hasApiId,
        hasApiHash,
        hasStringSession,
        connected: userbotConnected,
        accountName: userbotAccountName,
        username: userbotUsername,
        maxSizeMb: 2000,
        error: userbotError,
      },
      defaultChatId: process.env.TELEGRAM_CHAT_ID || '',
      ffmpegAvailable,
      logs: botLogs,
      security: {
        accessCode: activeCode,
        globalDefaultQuality: botSettings.globalDefaultQuality,
        preferFullSingleVideo: botSettings.preferFullSingleVideo,
        authorizedUsers: Object.values(botSettings.authorizedUsers),
        backupChannels: botSettings.backupChannels,
        routeRules: botSettings.routeRules,
        hfCloud: {
          isRunningOnHuggingFace: IS_RUNNING_ON_HF,
          ...botSettings.hfCloud,
        },
      },
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`StreamBridge Bot Status Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
