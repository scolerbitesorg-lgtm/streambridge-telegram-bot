/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Trash2,
  Terminal,
  ExternalLink,
  Activity,
  Server,
  ShieldCheck,
  KeyRound,
  Copy,
  Check,
  Clock,
  Sliders,
  UserCheck,
  UserX,
  FolderArchive,
  Route,
  Plus,
  Send,
  Film,
  Radio,
} from 'lucide-react';
import {
  AccessDurationKey,
  DownloadJob,
  TelegramConfigStatus,
  VideoQualityOption,
} from './types';

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 KB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(2)} MB`;
  const kb = bytes / 1024;
  return `${kb.toFixed(0)} KB`;
}

function formatRemainingTime(expiresAtIso?: string): string {
  if (!expiresAtIso) return '24h';
  const diffMs = new Date(expiresAtIso).getTime() - Date.now();
  if (diffMs <= 0) return 'Expired';
  const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
  const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  if (totalHours >= 24) {
    const days = Math.floor(totalHours / 24);
    const remHours = totalHours % 24;
    return `${days}d ${remHours}h left`;
  }
  return `${totalHours}h ${mins}m left`;
}

const DURATION_OPTIONS: { key: AccessDurationKey; label: string }[] = [
  { key: '24h', label: '24 Hours (Daily)' },
  { key: '48h', label: '48 Hours' },
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
];

const QUALITY_OPTIONS: { value: VideoQualityOption; label: string; sub: string }[] = [
  { value: '144p', label: '144p', sub: 'Data Saver' },
  { value: '240p', label: '240p', sub: 'Low' },
  { value: '360p', label: '360p', sub: 'Medium' },
  { value: '480p', label: '480p', sub: 'Standard' },
  { value: '720p', label: '720p HD', sub: 'Recommended' },
  { value: '1080p', label: '1080p FHD', sub: 'Max Quality' },
];

export default function App() {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [tgStatus, setTgStatus] = useState<TelegramConfigStatus | null>(null);
  const [selectedDuration, setSelectedDuration] = useState<AccessDurationKey>('24h');
  const [copiedCode, setCopiedCode] = useState(false);
  const [isGeneratingCode, setIsGeneratingCode] = useState(false);
  const [isUpdatingQuality, setIsUpdatingQuality] = useState(false);

  // Backup Channel Form State
  const [newBackupChatId, setNewBackupChatId] = useState('');
  const [newBackupTitle, setNewBackupTitle] = useState('');
  const [newBackupType, setNewBackupType] = useState<'channel' | 'group'>('channel');
  const [backupTestFeedback, setBackupTestFeedback] = useState<string | null>(null);

  // Fix Link -> Fix Channel Route Form State
  const [newRoutePattern, setNewRoutePattern] = useState('');
  const [newRouteTargetId, setNewRouteTargetId] = useState('');
  const [newRouteLabel, setNewRouteLabel] = useState('');

  // Hugging Face 1-Click 24/7 Auto-Deploy State
  const [hfTokenInput, setHfTokenInput] = useState('');
  const [hfSpaceNameInput, setHfSpaceNameInput] = useState('streambridge-bot');
  const [isDeployingHf, setIsDeployingHf] = useState(false);
  const [hfDeployResult, setHfDeployResult] = useState<{
    ok: boolean;
    message: string;
    spaceUrl?: string;
  } | null>(null);

  // GitHub -> Render.com 1-Click Auto-Deploy State (Works on Day-1 New Account, 0 Card)
  const [ghTokenInput, setGhTokenInput] = useState('');
  const [isDeployingGh, setIsDeployingGh] = useState(false);
  const [ghDeployResult, setGhDeployResult] = useState<{
    ok: boolean;
    message: string;
    repoUrl?: string;
    renderDeployUrl?: string;
  } | null>(null);

  // Keep-Alive Heartbeat State
  const [lastPingTime, setLastPingTime] = useState<string>('Active');

  const fetchBotState = useCallback(async () => {
    try {
      const [jobsRes, statusRes] = await Promise.all([
        fetch('/api/download/jobs'),
        fetch('/api/telegram/status'),
      ]);
      if (jobsRes.ok) {
        const jData = await jobsRes.json();
        setJobs(jData.jobs || []);
      }
      if (statusRes.ok) {
        const sData = (await statusRes.json()) as TelegramConfigStatus;
        setTgStatus(sData);
        if (sData.security?.accessCode?.durationKey) {
          setSelectedDuration(sData.security.accessCode.durationKey);
        }
      }
    } catch {
      // ignore transient poll error
    }
  }, []);

  useEffect(() => {
    fetchBotState();
    const timer = setInterval(fetchBotState, 2000);
    return () => clearInterval(timer);
  }, [fetchBotState]);

  // 20-second Keep-Alive Heartbeat + Screen WakeLock for 3-5 devices free hosting
  useEffect(() => {
    let wakeLockSentinel: any = null;
    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          wakeLockSentinel = await (navigator as any).wakeLock.request('screen');
        }
      } catch {
        // ignore if unsupported
      }
    };
    requestWakeLock();

    const pingInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/ping');
        if (res.ok) {
          setLastPingTime(new Date().toLocaleTimeString());
        }
      } catch {
        // ignore
      }
    }, 20000);

    return () => {
      clearInterval(pingInterval);
      if (wakeLockSentinel && typeof wakeLockSentinel.release === 'function') {
        wakeLockSentinel.release().catch(() => {});
      }
    };
  }, []);

  const handleClearFinished = async () => {
    try {
      const res = await fetch('/api/download/clear-finished', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setJobs(data.jobs || []);
      }
    } catch {
      // ignore
    }
  };

  const handleGenerateAccessCode = async (durKey?: AccessDurationKey) => {
    const targetDuration = durKey || selectedDuration;
    setIsGeneratingCode(true);
    try {
      const res = await fetch('/api/security/generate-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationKey: targetDuration }),
      });
      if (res.ok) {
        await fetchBotState();
      }
    } finally {
      setIsGeneratingCode(false);
    }
  };

  const handleCopyCode = async () => {
    const code = tgStatus?.security?.accessCode?.code;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2500);
    } catch {
      // fallback
    }
  };

  const handleSelectGlobalQuality = async (quality: VideoQualityOption) => {
    setIsUpdatingQuality(true);
    try {
      const res = await fetch('/api/settings/quality', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quality }),
      });
      if (res.ok) {
        await fetchBotState();
      }
    } finally {
      setIsUpdatingQuality(false);
    }
  };

  const handleToggleFullVideoMode = async (preferFullSingleVideo: boolean) => {
    try {
      const res = await fetch('/api/settings/video-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferFullSingleVideo }),
      });
      if (res.ok) {
        await fetchBotState();
      }
    } catch {
      // ignore
    }
  };

  const handleRevokeUser = async (chatId: string) => {
    try {
      const res = await fetch('/api/security/revoke-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId }),
      });
      if (res.ok) {
        await fetchBotState();
      }
    } catch {
      // ignore
    }
  };

  const handleAddBackupChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBackupChatId.trim()) return;
    try {
      const res = await fetch('/api/channels/backup/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: newBackupChatId.trim(),
          title: newBackupTitle.trim() || newBackupChatId.trim(),
          type: newBackupType,
        }),
      });
      if (res.ok) {
        setNewBackupChatId('');
        setNewBackupTitle('');
        await fetchBotState();
      }
    } catch {
      // ignore
    }
  };

  const handleToggleBackupChannel = async (id: string) => {
    try {
      await fetch('/api/channels/backup/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      await fetchBotState();
    } catch {
      // ignore
    }
  };

  const handleDeleteBackupChannel = async (id: string) => {
    try {
      await fetch('/api/channels/backup/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      await fetchBotState();
    } catch {
      // ignore
    }
  };

  const handleTestBackupChannel = async (chatId: string, title: string) => {
    setBackupTestFeedback(`Testing "${title}"...`);
    try {
      const res = await fetch('/api/channels/backup/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setBackupTestFeedback(`✅ Test message sent to "${title}" (${chatId})!`);
      } else {
        setBackupTestFeedback(`❌ Failed: ${data.error || 'Make sure Bot is Admin in that channel/group'}`);
      }
    } catch {
      setBackupTestFeedback(`❌ Network error testing channel`);
    }
    setTimeout(() => setBackupTestFeedback(null), 6000);
  };

  const handleAddRouteRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRoutePattern.trim() || !newRouteTargetId.trim()) return;
    const matchedBackup = (tgStatus?.security?.backupChannels || []).find(
      (b) => b.chatId === newRouteTargetId.trim()
    );
    const label = newRouteLabel.trim() || matchedBackup?.title || newRouteTargetId.trim();
    try {
      const res = await fetch('/api/channels/routes/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern: newRoutePattern.trim(),
          targetChatId: newRouteTargetId.trim(),
          targetTitle: label,
          label,
        }),
      });
      if (res.ok) {
        setNewRoutePattern('');
        setNewRouteLabel('');
        await fetchBotState();
      }
    } catch {
      // ignore
    }
  };

  const handleToggleRouteRule = async (id: string) => {
    try {
      await fetch('/api/channels/routes/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      await fetchBotState();
    } catch {
      // ignore
    }
  };

  const handleDeleteRouteRule = async (id: string) => {
    try {
      await fetch('/api/channels/routes/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      await fetchBotState();
    } catch {
      // ignore
    }
  };

  const handleDeployToHuggingFace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hfTokenInput.trim()) return;
    setIsDeployingHf(true);
    setHfDeployResult(null);
    try {
      const res = await fetch('/api/hf/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hfToken: hfTokenInput.trim(),
          spaceName: hfSpaceNameInput.trim() || 'streambridge-bot',
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setHfDeployResult({
          ok: true,
          message: `✅ 24/7 Space Deployed! Hugging Face is now building your Docker container (~2 mins). All Secrets & Backup Channels have been synced automatically!`,
          spaceUrl: data.hfCloud?.deployedSpaceUrl,
        });
        setHfTokenInput('');
        await fetchBotState();
      } else {
        setHfDeployResult({
          ok: false,
          message: data.error || 'Failed to deploy to Hugging Face Space',
        });
      }
    } catch (err: any) {
      setHfDeployResult({
        ok: false,
        message: err?.message || 'Network error while deploying to Hugging Face',
      });
    } finally {
      setIsDeployingHf(false);
    }
  };

  const handleToggleLocalPolling = async (pauseLocal: boolean) => {
    try {
      await fetch('/api/hf/toggle-polling', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPollingPaused: pauseLocal }),
      });
      await fetchBotState();
    } catch {
      // ignore
    }
  };

  const handleDeployToGitHubRender = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ghTokenInput.trim()) return;
    setIsDeployingGh(true);
    setGhDeployResult(null);
    try {
      const res = await fetch('/api/github/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          githubToken: ghTokenInput.trim(),
          repoName: 'streambridge-telegram-bot',
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setGhDeployResult({
          ok: true,
          message: '✅ Code + Dockerfile + render.yaml pushed to your GitHub! Click the button on the right to finish 1-Click Free Render Deploy:',
          repoUrl: data.repoUrl,
          renderDeployUrl: data.renderDeployUrl,
        });
        setGhTokenInput('');
      } else {
        setGhDeployResult({
          ok: false,
          message: data.error || 'Failed to push to GitHub',
        });
      }
    } catch (err: any) {
      setGhDeployResult({
        ok: false,
        message: err?.message || 'Network error while pushing to GitHub',
      });
    } finally {
      setIsDeployingGh(false);
    }
  };

  const activeJobs = jobs.filter(
    (j) =>
      j.status === 'downloading' ||
      j.status === 'merging' ||
      j.status === 'uploading_bot_api' ||
      j.status === 'uploading_mtproto_userbot' ||
      j.status === 'queued'
  );

  const finishedCount = jobs.filter(
    (j) => j.status === 'completed' || j.status === 'failed'
  ).length;

  const botUsername = tgStatus?.botApi.username || 'Updates_send_me_bot';
  const currentCode = tgStatus?.security?.accessCode?.code || 'LOADING...';
  const currentCodeLabel = tgStatus?.security?.accessCode?.durationLabel || '24 Hours (Daily)';
  const currentCodeExpiry = tgStatus?.security?.accessCode?.expiresAt;
  const globalQuality = tgStatus?.security?.globalDefaultQuality || '720p';
  const preferFullSingleVideo = tgStatus?.security?.preferFullSingleVideo ?? true;
  const authorizedUsers = tgStatus?.security?.authorizedUsers || [];
  const backupChannels = tgStatus?.security?.backupChannels || [];
  const routeRules = tgStatus?.security?.routeRules || [];
  const hfCloud = tgStatus?.security?.hfCloud;

  return (
    <div className="min-h-screen bg-[#0B0F19] text-slate-100 flex flex-col">
      {/* Top Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 lg:px-10 py-4 border-b border-slate-800/90 bg-[#0B0F19]/95">
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-lg font-bold tracking-tight text-white whitespace-nowrap">
            StreamBridge Bot Control
          </span>
          <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-[11px] font-mono text-emerald-400">
            <Radio className="w-3 h-3 animate-pulse" />
            {hfCloud?.isRunningOnHuggingFace ? '24/7 HF Cloud Active' : `Keep-Alive: ${lastPingTime}`}
          </span>
        </div>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
          <a href="#hf-cloud" className="text-amber-300 hover:text-amber-200 transition-colors whitespace-nowrap shrink-0">
            24/7 HuggingFace Setup
          </a>
          <a href="#security" className="hover:text-white transition-colors whitespace-nowrap shrink-0">
            Access Code &amp; Quality
          </a>
          <a href="#channels" className="hover:text-white transition-colors whitespace-nowrap shrink-0">
            Backup Channels ({backupChannels.length})
          </a>
          <a href="#queue" className="hover:text-white transition-colors whitespace-nowrap shrink-0">
            Live Queue ({activeJobs.length})
          </a>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          <a
            href={`https://t.me/${botUsername}`}
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 rounded-lg hover:bg-sky-300 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            Open @{botUsername}
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </header>

      {/* Main Status Indicator Canvas */}
      <main className="flex-1 w-full max-w-[1200px] mx-auto px-6 lg:px-10 py-8 space-y-8">
        {/* Access Code Gate & Global Quality Control Grid */}
        <section id="security" className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left 7 Cols: Daily / Timed Unique Access Code Generator */}
          <div className="lg:col-span-7 border border-slate-800 bg-[#111827] rounded-xl p-6 flex flex-col justify-between space-y-6">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2 text-xs font-mono text-amber-400">
                  <KeyRound className="w-4 h-4" />
                  <span>TELEGRAM BOT ACCESS GATE · ANTI-UNAUTHORIZED PROTECTION</span>
                </div>
                <span className="text-xs font-mono text-emerald-400 flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" />
                  {formatRemainingTime(currentCodeExpiry)}
                </span>
              </div>
              <h2 className="text-xl font-bold text-white tracking-tight">
                Unique Bot Activation Code
              </h2>
              <p className="text-xs text-slate-400">
                Koi bhi random user bot ko access nahi kar payega. Neeche button ke andar generate hua code copy karke Telegram bot (<strong className="text-slate-200">@{botUsername}</strong>) me bhejein tabhi bot us account ke liye active hoga.
              </p>
            </div>

            {/* Interactive Unique Code Button Box */}
            <div className="space-y-3">
              <button
                type="button"
                onClick={handleCopyCode}
                className="w-full p-4 rounded-xl bg-slate-950 border border-amber-500/40 hover:border-amber-400 transition-all flex items-center justify-between gap-4 group cursor-pointer"
              >
                <div className="text-left">
                  <div className="text-[11px] font-mono uppercase tracking-wider text-slate-400">
                    Active Unlock Code ({currentCodeLabel}) — Click to Copy
                  </div>
                  <div className="text-2xl sm:text-3xl font-mono font-bold tracking-widest text-amber-400 mt-1">
                    {currentCode}
                  </div>
                </div>
                <div className="px-4 py-2.5 rounded-lg bg-amber-400/10 border border-amber-400/30 text-amber-300 text-xs font-semibold flex items-center gap-2 group-hover:bg-amber-400 group-hover:text-slate-950 transition-colors shrink-0">
                  {copiedCode ? (
                    <>
                      <Check className="w-4 h-4" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" />
                      Copy Code
                    </>
                  )}
                </div>
              </button>

              {/* Expiry Duration Selector + Generate New Code Button */}
              <div className="pt-2 space-y-2.5">
                <div className="text-xs font-medium text-slate-300">
                  Select Code Validity Time &amp; Generate New Code:
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {DURATION_OPTIONS.map((opt) => {
                    const active = selectedDuration === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => {
                          setSelectedDuration(opt.key);
                          handleGenerateAccessCode(opt.key);
                        }}
                        disabled={isGeneratingCode}
                        className={`px-3 py-2 rounded-lg text-xs font-mono font-medium border transition-colors cursor-pointer ${
                          active
                            ? 'bg-sky-500/15 border-sky-400 text-sky-300'
                            : 'bg-slate-900/90 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>

                <button
                  type="button"
                  onClick={() => handleGenerateAccessCode(selectedDuration)}
                  disabled={isGeneratingCode}
                  className="w-full py-2.5 px-4 rounded-lg bg-sky-400 hover:bg-sky-300 text-slate-950 font-semibold text-xs transition-colors flex items-center justify-center gap-2 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isGeneratingCode ? 'animate-spin' : ''}`} />
                  Generate New Unique Code ({DURATION_OPTIONS.find((d) => d.key === selectedDuration)?.label})
                </button>
              </div>
            </div>

            {/* Active Authorized Telegram Accounts */}
            <div className="pt-4 border-t border-slate-800/80 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                  <UserCheck className="w-3.5 h-3.5 text-emerald-400" />
                  Authorized Telegram Accounts ({authorizedUsers.length})
                </span>
                <span className="text-slate-500 font-mono">3–5 Devices Supported</span>
              </div>

              {authorizedUsers.length === 0 ? (
                <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80 text-xs text-slate-400">
                  Abhi koi account active nahi hai. Upar diya gaya code <code className="text-amber-300">{currentCode}</code> copy karke Telegram bot me bhejein.
                </div>
              ) : (
                <div className="space-y-2 max-h-36 overflow-y-auto">
                  {authorizedUsers.map((u) => (
                    <div
                      key={u.chatId}
                      className="px-3.5 py-2 rounded-lg bg-slate-950/80 border border-slate-800 flex items-center justify-between gap-3 text-xs font-mono"
                    >
                      <div className="min-w-0">
                        <div className="text-slate-200 font-sans font-medium truncate">
                          {u.firstName || u.name || 'Telegram User'} {u.username ? `(@${u.username})` : ''}
                        </div>
                        <div className="text-[11px] text-slate-400">
                          ID: {u.chatId} · {formatRemainingTime(u.expiresAt)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRevokeUser(u.chatId)}
                        className="px-2.5 py-1 rounded bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 flex items-center gap-1 shrink-0 cursor-pointer"
                      >
                        <UserX className="w-3 h-3" />
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right 5 Cols: Global Default Video Quality & Full Video Delivery Mode */}
          <div className="lg:col-span-5 border border-slate-800 bg-[#111827] rounded-xl p-6 flex flex-col justify-between space-y-5">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-mono text-sky-400">
                <Sliders className="w-4 h-4" />
                <span>GLOBAL DEFAULT QUALITY &amp; FULL VIDEO FORMAT</span>
              </div>
              <h2 className="text-xl font-bold text-white tracking-tight">
                Default Quality ({globalQuality.toUpperCase()})
              </h2>
              <p className="text-xs text-slate-400">
                Yahan se select ki gayi quality me har video proper streamable <code className="text-slate-200">.mp4</code> format (with thumbnail, duration &amp; seekbar) me save aur send hogi.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              {QUALITY_OPTIONS.map((q) => {
                const isSelected = globalQuality === q.value;
                return (
                  <button
                    key={q.value}
                    type="button"
                    disabled={isUpdatingQuality}
                    onClick={() => handleSelectGlobalQuality(q.value)}
                    className={`p-3 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between ${
                      isSelected
                        ? 'bg-emerald-500/15 border-emerald-400 text-white'
                        : 'bg-slate-950/70 border-slate-800 text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <span className="text-sm font-bold font-mono">{q.label}</span>
                      {isSelected && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />}
                    </div>
                    <span className="text-[11px] text-slate-400 mt-0.5">{q.sub}</span>
                  </button>
                );
              })}
            </div>

            {/* Full Complete Video (Puri Video) Mode Selector */}
            <div className="p-3.5 rounded-xl bg-slate-950/90 border border-slate-800 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                  <Film className="w-3.5 h-3.5 text-emerald-400" />
                  Video Delivery Format (Puri Video vs Split)
                </span>
                <span className="text-[11px] font-mono text-emerald-400">
                  {preferFullSingleVideo ? 'FULL VIDEO ACTIVE' : 'SPLIT MODE'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => handleToggleFullVideoMode(true)}
                  className={`px-3 py-2 rounded-lg text-xs font-medium border text-left cursor-pointer transition-colors ${
                    preferFullSingleVideo
                      ? 'bg-emerald-500/15 border-emerald-400 text-emerald-300'
                      : 'bg-slate-900 border-slate-800 text-slate-400'
                  }`}
                >
                  <div className="font-semibold">Full Video (Puri Video)</div>
                  <div className="text-[10px] opacity-80">Single MP4 up to 2GB</div>
                </button>
                <button
                  type="button"
                  onClick={() => handleToggleFullVideoMode(false)}
                  className={`px-3 py-2 rounded-lg text-xs font-medium border text-left cursor-pointer transition-colors ${
                    !preferFullSingleVideo
                      ? 'bg-sky-500/15 border-sky-400 text-sky-300'
                      : 'bg-slate-900 border-slate-800 text-slate-400'
                  }`}
                >
                  <div className="font-semibold">Split Parts (&lt;48MB)</div>
                  <div className="text-[10px] opacity-80">Multi-part Bot API</div>
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* NEW SECTION: Backup Channels/Groups Vault & Fix-Link to Fix-Channel Routing */}
        <section id="channels" className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left 6 Cols: Multiple Backup Channels & Groups Vault */}
          <div className="lg:col-span-6 border border-slate-800 bg-[#111827] rounded-xl p-6 flex flex-col justify-between space-y-5">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-mono text-emerald-400">
                  <FolderArchive className="w-4 h-4" />
                  <span>AUTO-BACKUP CHANNELS &amp; GROUPS VAULT</span>
                </div>
                <span className="text-xs font-mono text-slate-400">
                  {backupChannels.filter((b) => b.enabled).length} Active
                </span>
              </div>
              <h2 className="text-lg font-bold text-white tracking-tight">
                Backup Channels / Groups (Save All Videos)
              </h2>
              <p className="text-xs text-slate-400">
                Bot se download hone wali <strong className="text-slate-200">saari videos</strong> yahan add kiye gaye Channels/Groups me automatically as a backup save hongi.
                <br />
                <span className="text-sky-400">
                  💡 Shortcut: Bot (@{botUsername}) ko kisi bhi Channel ya Group me Admin banayein ya Channel ki koi post Bot ko forward karein — Bot khud auto-add kar lega!
                </span>
              </p>
            </div>

            <form onSubmit={handleAddBackupChannel} className="space-y-2.5">
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                <input
                  type="text"
                  value={newBackupChatId}
                  onChange={(e) => setNewBackupChatId(e.target.value)}
                  placeholder="Channel/Group ID (e.g. -100192837465 or @channel)"
                  className="sm:col-span-6 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                />
                <input
                  type="text"
                  value={newBackupTitle}
                  onChange={(e) => setNewBackupTitle(e.target.value)}
                  placeholder="Label (e.g. Master Video Backup)"
                  className="sm:col-span-4 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white focus:outline-none focus:border-sky-400"
                />
                <select
                  value={newBackupType}
                  onChange={(e) => setNewBackupType(e.target.value as 'channel' | 'group')}
                  className="sm:col-span-2 px-2 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-sky-400"
                >
                  <option value="channel">Channel</option>
                  <option value="group">Group</option>
                </select>
              </div>
              <button
                type="submit"
                className="w-full py-2 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Backup Channel / Group
              </button>
            </form>

            {backupTestFeedback && (
              <div className="p-2.5 rounded-lg bg-slate-950 border border-sky-500/40 text-xs text-sky-300 font-mono">
                {backupTestFeedback}
              </div>
            )}

            <div className="space-y-2 max-h-56 overflow-y-auto pt-2 border-t border-slate-800/80">
              {backupChannels.length === 0 ? (
                <div className="p-4 rounded-lg bg-slate-950/60 border border-slate-800/80 text-xs text-slate-400 text-center">
                  Abhi koi Backup Channel/Group add nahi hai. @{botUsername} ko apne Backup Channel ya Group me Admin banate hi wo yahan apne aap aa jayega, ya upar ID daal kar add karein.
                </div>
              ) : (
                backupChannels.map((ch) => (
                  <div
                    key={ch.id}
                    className="p-3 rounded-lg bg-slate-950/80 border border-slate-800 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            ch.enabled ? 'bg-emerald-400' : 'bg-slate-600'
                          }`}
                        />
                        <span className="font-semibold text-white truncate">{ch.title}</span>
                        <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-[10px] font-mono text-slate-400 uppercase">
                          {ch.type}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                        ID: {ch.chatId} · Added via {ch.addedVia.toUpperCase()}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleTestBackupChannel(ch.chatId, ch.title)}
                        className="px-2 py-1 rounded bg-sky-500/10 border border-sky-500/30 text-sky-300 hover:bg-sky-500/20 text-[11px] font-mono flex items-center gap-1 cursor-pointer"
                      >
                        <Send className="w-3 h-3" />
                        Test
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleBackupChannel(ch.id)}
                        className={`px-2 py-1 rounded border text-[11px] font-mono cursor-pointer ${
                          ch.enabled
                            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                            : 'bg-slate-900 border-slate-700 text-slate-400'
                        }`}
                      >
                        {ch.enabled ? 'Active' : 'Paused'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteBackupChannel(ch.id)}
                        className="p-1.5 rounded bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Right 6 Cols: Fix Link -> Fix Channel Routing Rules */}
          <div className="lg:col-span-6 border border-slate-800 bg-[#111827] rounded-xl p-6 flex flex-col justify-between space-y-5">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-mono text-sky-400">
                  <Route className="w-4 h-4" />
                  <span>FIX LINK → FIX CHANNEL DEDICATED ROUTING</span>
                </div>
                <span className="text-xs font-mono text-slate-400">
                  {routeRules.filter((r) => r.enabled).length} Rules Active
                </span>
              </div>
              <h2 className="text-lg font-bold text-white tracking-tight">
                Send Specific Link Videos to a Specific Channel
              </h2>
              <p className="text-xs text-slate-400">
                Agar aap chahte hain ki kisi <strong className="text-slate-200">Fix Link ya Course</strong> (jaise <code className="text-slate-300">subjectid=1677</code> ya pura topic URL) ki saari videos ek <strong className="text-slate-200">Fix Channel</strong> me jayein, to yahan rule add karein. (Saath hi Backup Group me bhi save hongi!)
              </p>
            </div>

            <form onSubmit={handleAddRouteRule} className="space-y-2.5">
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                <input
                  type="text"
                  value={newRoutePattern}
                  onChange={(e) => setNewRoutePattern(e.target.value)}
                  placeholder="Fix Link or Keyword (e.g. subjectid=1677 or full URL)"
                  className="sm:col-span-5 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                />
                <input
                  type="text"
                  list="saved-channels-list"
                  value={newRouteTargetId}
                  onChange={(e) => setNewRouteTargetId(e.target.value)}
                  placeholder="Target Channel ID (-100...)"
                  className="sm:col-span-4 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                />
                <datalist id="saved-channels-list">
                  {backupChannels.map((b) => (
                    <option key={b.id} value={b.chatId}>
                      {b.title}
                    </option>
                  ))}
                </datalist>
                <input
                  type="text"
                  value={newRouteLabel}
                  onChange={(e) => setNewRouteLabel(e.target.value)}
                  placeholder="Channel Name"
                  className="sm:col-span-3 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white focus:outline-none focus:border-sky-400"
                />
              </div>
              <button
                type="submit"
                className="w-full py-2 px-4 rounded-lg bg-sky-400 hover:bg-sky-300 text-slate-950 font-semibold text-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                Save Fix Link → Fix Channel Rule
              </button>
            </form>

            <div className="space-y-2 max-h-56 overflow-y-auto pt-2 border-t border-slate-800/80">
              {routeRules.length === 0 ? (
                <div className="p-4 rounded-lg bg-slate-950/60 border border-slate-800/80 text-xs text-slate-400 text-center">
                  Koi Fix-Link rule nahi laga hai — abhi saari videos aapke Chat aur Backup Channels/Groups me jayengi.
                  <br />
                  <span className="text-slate-500 font-mono">
                    Bot me direct aise bhi bhej sakte hain: https://link... -&gt; -100123456789
                  </span>
                </div>
              ) : (
                routeRules.map((rule) => (
                  <div
                    key={rule.id}
                    className="p-3 rounded-lg bg-slate-950/80 border border-slate-800 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sky-300 truncate">{rule.pattern}</span>
                        <span className="text-slate-500">→</span>
                        <span className="font-semibold text-white truncate">{rule.targetTitle}</span>
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                        Target Channel ID: {rule.targetChatId}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleToggleRouteRule(rule.id)}
                        className={`px-2 py-1 rounded border text-[11px] font-mono cursor-pointer ${
                          rule.enabled
                            ? 'bg-sky-500/10 border-sky-500/30 text-sky-300'
                            : 'bg-slate-900 border-slate-700 text-slate-400'
                        }`}
                      >
                        {rule.enabled ? 'Active' : 'Paused'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteRouteRule(rule.id)}
                        className="p-1.5 rounded bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        {/* Hero Status Banner */}
        <section id="status" className="border border-slate-800 bg-[#111827] rounded-xl p-6 lg:p-8">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
            <div className="space-y-2">
              <div className="flex items-center gap-2.5 text-xs font-mono text-emerald-400">
                <Activity className="w-4 h-4" />
                <span>
                  {tgStatus?.botApi.connected
                    ? 'TELEGRAM BOT ENGINE ONLINE · FULL VIDEO MP4 + AUTO-BACKUP ACTIVE'
                    : 'CONNECTING TO TELEGRAM BOT API...'}
                </span>
              </div>
              <h1 className="text-2xl lg:text-3xl font-bold text-white tracking-tight">
                @{botUsername} — Live Bot Status Indicator
              </h1>
              <p className="text-sm text-slate-400 max-w-2xl">
                Every downloaded video is packaged as a complete, streamable <code className="text-slate-200">.mp4</code> with thumbnail, duration, and resolution, and automatically backed up to your configured Channels &amp; Groups.
              </p>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <button
                type="button"
                onClick={fetchBotState}
                className="px-4 py-2.5 text-xs font-medium bg-slate-800 text-slate-200 rounded-lg hover:bg-slate-700 transition-colors flex items-center gap-2 whitespace-nowrap cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Refresh Status
              </button>
            </div>
          </div>

          {/* 4-Column System Indicator Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-6 pt-6 border-t border-slate-800/80 font-mono tabular-nums">
            <div className="p-4 rounded-lg bg-slate-950/70 border border-slate-800/80 space-y-1">
              <div className="text-xs text-slate-400">Bot Polling Status</div>
              <div className="text-sm font-semibold text-emerald-400 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{tgStatus?.botApi.connected ? 'Online & Listening' : 'Initializing'}</span>
              </div>
              <div className="text-xs text-slate-500">@{botUsername}</div>
            </div>

            <div className="p-4 rounded-lg bg-slate-950/70 border border-slate-800/80 space-y-1">
              <div className="text-xs text-slate-400">2GB MTProto Userbot</div>
              <div className="text-sm font-semibold text-emerald-400 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                <span>{tgStatus?.userbotMtproto.connected ? 'Connected (Full 2GB MP4)' : 'Standby'}</span>
              </div>
              <div className="text-xs text-slate-500">
                {tgStatus?.userbotMtproto.accountName || 'MTProto Relay Active'}
              </div>
            </div>

            <div className="p-4 rounded-lg bg-slate-950/70 border border-slate-800/80 space-y-1">
              <div className="text-xs text-slate-400">Auto-Backup Vault</div>
              <div className="text-sm font-semibold text-sky-400 flex items-center gap-1.5">
                <Server className="w-4 h-4 shrink-0" />
                <span>{backupChannels.filter((b) => b.enabled).length} Channels / Groups</span>
              </div>
              <div className="text-xs text-slate-500">
                Link Rules: {routeRules.filter((r) => r.enabled).length} Active
              </div>
            </div>

            <div className="p-4 rounded-lg bg-slate-950/70 border border-slate-800/80 space-y-1">
              <div className="text-xs text-slate-400">Active / Queued Tasks</div>
              <div className="text-sm font-semibold text-white">
                {activeJobs.length} Running · {finishedCount} Finished
              </div>
              <div className="text-xs text-slate-500">Authorized Accounts: {authorizedUsers.length}</div>
            </div>
          </div>
        </section>

        {/* Live Bot Queue Monitor (Read-Only Indicator + Clear Finished) */}
        <section id="queue" className="border border-slate-800 bg-[#111827] rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Live Telegram Bot Task Indicator
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Real-time indicator of full videos currently being downloaded, packaged into MP4, and saved to your Chat &amp; Backup Channels.
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleClearFinished}
                disabled={finishedCount === 0}
                className="px-3.5 py-1.5 text-xs font-medium bg-slate-900 border border-slate-800 text-slate-200 rounded-lg hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5 text-red-400" />
                Clear Finished ({finishedCount})
              </button>
            </div>
          </div>

          {jobs.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400">
              Bot is idle and waiting for links on Telegram. Send any <code className="text-slate-200">.m3u8</code>, player URL, or multi-folder course URL to <strong className="text-white">@{botUsername}</strong>.
            </div>
          ) : (
            <div className="divide-y divide-slate-800 max-h-96 overflow-y-auto">
              {jobs.map((job) => (
                <div key={job.id} className="px-6 py-4 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-white truncate">{job.title}</div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 font-mono tabular-nums mt-0.5">
                        <span>{job.status.toUpperCase()}</span>
                        {job.folderName && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-sky-400">Folder: {job.folderName}</span>
                          </>
                        )}
                        <span aria-hidden="true">·</span>
                        <span>
                          Segments: {job.completedSegments}/{job.totalSegments}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{formatBytes(job.downloadedBytes)}</span>
                        {job.speedBytesPerSec > 0 && job.status === 'downloading' && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-emerald-400">
                              {formatBytes(job.speedBytesPerSec)}/s
                            </span>
                          </>
                        )}
                        {job.telegramResult?.routedToChannel && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-amber-300">
                              Routed: {job.telegramResult.routedToChannel}
                            </span>
                          </>
                        )}
                        {job.telegramResult?.backedUpTo && job.telegramResult.backedUpTo.length > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-emerald-400">
                              Backed Up: {job.telegramResult.backedUpTo.join(', ')}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    <span className="text-xs font-mono tabular-nums text-slate-300">
                      {job.progressPercent}%
                    </span>
                  </div>

                  <div className="w-full bg-slate-900 h-1.5 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${
                        job.status === 'failed'
                          ? 'bg-red-500'
                          : job.status === 'completed'
                          ? 'bg-emerald-500'
                          : 'bg-sky-400'
                      }`}
                      style={{ width: `${Math.max(3, job.progressPercent)}%` }}
                    />
                  </div>

                  {job.error && (
                    <div className="text-xs text-red-400 font-mono flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      <span>{job.error}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 1-Click Hugging Face 24/7 Cloud Auto-Deployer Section */}
        <section id="hf-cloud" className="border border-amber-500/30 bg-[#111827] rounded-xl p-6 space-y-5">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800 pb-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs font-mono text-amber-400">
                <Server className="w-4 h-4" />
                <span>24/7 HUGGING FACE CLOUD AUTO-DEPLOY · BINA WEB KHULE 24/7 BOT CHALAYEIN (100% FREE, NO CARD)</span>
              </div>
              <h2 className="text-lg font-bold text-white">
                1-Click Hugging Face 24/7 Space Integrator
              </h2>
              <p className="text-xs text-slate-400 max-w-3xl">
                Yahan apna Hugging Face <strong className="text-slate-200">Write Token (hf_...)</strong> dalein aur button dabayein. Ye system khud aapke Hugging Face account par Docker Space banayega, saare <strong className="text-slate-200">5 Telegram &amp; Userbot Secrets</strong> automatically upload karega, aur pura code + Backup Channels push kar dega — jisse web band hone ke baad bhi bot 24/7 chalta rahega!
              </p>
            </div>

            {hfCloud?.deployedSpaceUrl && (
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <a
                  href={hfCloud.deployedSpaceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3.5 py-2 text-xs font-semibold bg-amber-400 text-slate-950 rounded-lg hover:bg-amber-300 transition-colors flex items-center gap-1.5"
                >
                  Open Your 24/7 HF Space
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
                <button
                  type="button"
                  onClick={() => handleToggleLocalPolling(!hfCloud.localPollingPaused)}
                  className={`px-3 py-2 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                    hfCloud.localPollingPaused
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                      : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {hfCloud.localPollingPaused
                    ? '☁️ Running on Hugging Face 24/7 (Click to Resume Local)'
                    : '🔄 Handover Polling to HF Space'}
                </button>
              </div>
            )}
          </div>

          <form onSubmit={handleDeployToHuggingFace} className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="md:col-span-6">
              <label className="block text-[11px] font-mono text-slate-400 mb-1">
                1. Hugging Face Write Token (starts with hf_...)
              </label>
              <input
                type="password"
                value={hfTokenInput}
                onChange={(e) => setHfTokenInput(e.target.value)}
                placeholder="hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                className="w-full px-3.5 py-2.5 text-xs font-mono bg-slate-950 border border-slate-800 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
              />
            </div>

            <div className="md:col-span-3">
              <label className="block text-[11px] font-mono text-slate-400 mb-1">
                2. Space Name
              </label>
              <input
                type="text"
                value={hfSpaceNameInput}
                onChange={(e) => setHfSpaceNameInput(e.target.value)}
                placeholder="streambridge-bot"
                className="w-full px-3.5 py-2.5 text-xs font-mono bg-slate-950 border border-slate-800 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
              />
            </div>

            <div className="md:col-span-3 flex items-end">
              <button
                type="submit"
                disabled={isDeployingHf || !hfTokenInput.trim()}
                className="w-full px-4 py-2.5 text-xs font-semibold bg-amber-400 text-slate-950 rounded-lg hover:bg-amber-300 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Server className="w-3.5 h-3.5" />
                {isDeployingHf ? 'Deploying to HF 24/7...' : '1-Click Auto-Deploy to HF'}
              </button>
            </div>
          </form>

          {hfDeployResult && (
            <div
              className={`p-3.5 rounded-lg border text-xs font-mono flex flex-wrap items-center justify-between gap-3 ${
                hfDeployResult.ok
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                  : 'bg-red-500/10 border-red-500/30 text-red-300'
              }`}
            >
              <span>{hfDeployResult.message}</span>
              {hfDeployResult.spaceUrl && (
                <a
                  href={hfDeployResult.spaceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline font-semibold text-white flex items-center gap-1"
                >
                  Open Space Build Logs <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          )}

          {/* Option B: 1-Click GitHub -> Render.com Free Auto-Deployer (Works on Day-1 New Account, Zero Card) */}
          <div className="pt-4 border-t border-slate-800 space-y-3">
            <div className="space-y-1">
              <div className="text-xs font-mono text-emerald-400 font-semibold">
                OPTION B (READY &amp; PUSHED TO YOUR GITHUB): 1-CLICK GITHUB → RENDER.COM (100% FREE, NO CARD, ZERO TYPING)
              </div>
              <p className="text-xs text-slate-400">
                Aapka pura bot code, Dockerfile, aur encrypted 5-Secrets Vault aapke GitHub (<strong className="text-white">{hfCloud?.githubRepoUrl || 'scolerbitesorg-lgtm/streambridge-telegram-bot'}</strong>) par push ho chuka hai! Ab bas neeche <strong className="text-emerald-400">🚀 1-Click Launch Free on Render.com</strong> button par click karein — wahan koi form ya secret bharne ki zaroorat nahi hai, bas <strong className="text-white">Apply</strong> dabayein!
              </p>
            </div>

            {(ghDeployResult?.renderDeployUrl || hfCloud?.renderDeployUrl) && (
              <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/40 flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="text-xs font-mono font-bold text-emerald-300">
                    ✅ GitHub Repo Live &amp; Pre-Configured with All 5 Telegram/Userbot Secrets!
                  </div>
                  <div className="text-xs font-mono text-slate-300">
                    Repo:{' '}
                    <a
                      href={ghDeployResult?.repoUrl || hfCloud?.githubRepoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sky-400 underline"
                    >
                      {ghDeployResult?.repoUrl || hfCloud?.githubRepoUrl}
                    </a>
                  </div>
                </div>
                <a
                  href={ghDeployResult?.renderDeployUrl || hfCloud?.renderDeployUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-5 py-2.5 rounded-lg bg-emerald-400 text-slate-950 text-xs font-bold flex items-center gap-2 hover:bg-emerald-300 transition-colors shadow-lg"
                >
                  🚀 1-Click Launch Free on Render.com (No Secrets to Type!)
                  <ExternalLink className="w-4 h-4" />
                </a>
              </div>
            )}

            <form onSubmit={handleDeployToGitHubRender} className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-9">
                <input
                  type="password"
                  value={ghTokenInput}
                  onChange={(e) => setGhTokenInput(e.target.value)}
                  placeholder="Paste GitHub Token (ghp_... from github.com/settings/tokens/new with 'repo' checked)"
                  className="w-full px-3.5 py-2.5 text-xs font-mono bg-slate-950 border border-slate-800 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-emerald-400"
                />
              </div>
              <div className="md:col-span-3">
                <button
                  type="submit"
                  disabled={isDeployingGh || !ghTokenInput.trim()}
                  className="w-full px-4 py-2.5 text-xs font-semibold bg-emerald-400 text-slate-950 rounded-lg hover:bg-emerald-300 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Server className="w-3.5 h-3.5" />
                  {isDeployingGh ? 'Pushing to GitHub...' : 'Re-Push Latest Changes to GitHub'}
                </button>
              </div>
            </form>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs font-mono pt-1">
            <div className="p-3.5 rounded-lg bg-slate-950/70 border border-slate-800 space-y-1">
              <div className="text-amber-400 font-semibold">Step 1: Get Free HF Write Token</div>
              <p className="text-slate-300 font-sans">
                <a
                  href="https://huggingface.co/settings/tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sky-400 underline"
                >
                  huggingface.co/settings/tokens
                </a>{' '}
                par jayein → <strong>Create new token</strong> → Type me <strong>Write</strong> select karein aur token (<code className="text-white">hf_...</code>) copy karein.
              </p>
            </div>

            <div className="p-3.5 rounded-lg bg-slate-950/70 border border-slate-800 space-y-1">
              <div className="text-emerald-400 font-semibold">Step 2: Paste &amp; Click Deploy</div>
              <p className="text-slate-300 font-sans">
                Upar box me <code className="text-white">hf_...</code> token dalein aur <strong>1-Click Auto-Deploy to HF</strong> dabayein. Aapke saare secrets aur code khud push ho jayenge!
              </p>
            </div>

            <div className="p-3.5 rounded-lg bg-slate-950/70 border border-slate-800 space-y-1">
              <div className="text-sky-400 font-semibold">Step 3: 24/7 Non-Stop Hosting</div>
              <p className="text-slate-300 font-sans">
                2 minute me Hugging Face Space <strong className="text-emerald-400">Running</strong> ho jayega. Uske baad aap saare web tabs band kar sakte hain — bot 24/7 chalta rahega!
              </p>
            </div>
          </div>
        </section>

        {/* Live Bot Activity Telemetry */}
        <section id="logs" className="border border-slate-800 bg-[#111827] rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-sky-400" />
              <h2 className="text-sm font-semibold text-slate-100">
                Live Bot Activity Logs
              </h2>
            </div>
            <span className="text-xs font-mono tabular-nums text-slate-400">
              {tgStatus?.logs.length || 0} recent events
            </span>
          </div>

          {!tgStatus?.logs || tgStatus.logs.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400">
              Waiting for incoming Telegram messages...
            </div>
          ) : (
            <div className="divide-y divide-slate-800/80 max-h-64 overflow-y-auto">
              {tgStatus.logs.map((log) => (
                <div
                  key={log.id}
                  className="px-6 py-3 flex flex-wrap items-center justify-between gap-4 text-xs font-mono tabular-nums"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span className="text-slate-500 shrink-0">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="text-slate-400 shrink-0">[{log.direction}]</span>
                    <span className="text-slate-200 truncate">{log.summary}</span>
                  </div>
                  <span className="text-slate-400 shrink-0">Chat: {log.chatId}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
