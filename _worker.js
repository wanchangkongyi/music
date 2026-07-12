const DEFAULT_SITE_NAME = 'OTC 音乐网';
const DEFAULT_MUSIC_API_BASE = 'https://music.haitangw.cc';
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return corsPreflightResponse();
    }
    if (url.pathname === '/api/sync') {
      return handleSync(request, env);
    }
    if (url.pathname === '/api/lyrics') {
      return handleLyrics(request, env, ctx);
    }
    const siteName = env.SITE_NAME || DEFAULT_SITE_NAME;
    const musicApiBase = (env.MUSIC_API_BASE || DEFAULT_MUSIC_API_BASE).replace(/\/$/, '');
    if (url.pathname.startsWith('/proxy/')) {
      return handleProxy(request, url, musicApiBase);
    }
    const origin = url.origin;
    const proxyBase = origin + '/proxy/';
    return new Response(buildHTML(proxyBase, siteName, musicApiBase), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  },
};
function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
const UID_RE = /^[A-Za-z0-9_-]{6,64}$/;
async function handleLyrics(request, env, ctx) {
  const u = new URL(request.url);
  const songmid = (u.searchParams.get('songmid') || '').trim();
  const songid  = (u.searchParams.get('songid')  || '').trim();
  if (!songmid && !songid) return jsonResponse({ error: 'missing songmid' }, 400);
  const cacheKey = 'lyric:' + (songmid || songid);
  if (env.MUSIC_KV) {
    try {
      const cached = await env.MUSIC_KV.get(cacheKey);
      if (cached !== null) return jsonResponse({ lyric: cached, cached: true });
    } catch { /* KV 读取失败时降级为直接请求上游 */ }
  }
  const body = {
    req_1: {
      module: 'music.musichallSong.PlayLyricInfo',
      method: 'GetPlayLyricInfo',
      param: { songMID: songmid, songID: songid ? Number(songid) : 0 },
    }
  };
  try {
    const upstream = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://y.qq.com/',
        'Origin': 'https://y.qq.com',
      },
      body: JSON.stringify(body),
    });
    const data = await upstream.json();
    const raw = data?.req_1?.data?.lyric || '';
    if (raw && env.MUSIC_KV) {
      const put = env.MUSIC_KV.put(cacheKey, raw, { expirationTtl: 60 * 60 * 24 * 30 });
      if (ctx?.waitUntil) ctx.waitUntil(put); else await put.catch(() => {});
    }
    return jsonResponse({ lyric: raw });
  } catch (err) {
    return jsonResponse({ error: 'upstream_failed' }, 502);
  }
}
async function handleSync(request, env) {
  if (!env.MUSIC_KV) {
    return jsonResponse({ error: 'KV 未绑定，请在项目设置中绑定名为 MUSIC_KV 的 KV 命名空间' }, 500);
  }
  if (request.method === 'GET') {
    const uid = new URL(request.url).searchParams.get('uid') || '';
    if (!UID_RE.test(uid)) return jsonResponse({ error: 'invalid uid' }, 400);
    const raw = await env.MUSIC_KV.get('sync:' + uid);
    const data = raw ? JSON.parse(raw) : { favorites: [], playlists: [], history: [], updatedAt: 0 };
    return jsonResponse(data);
  }
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'invalid json' }, 400); }
    const uid = body.uid || '';
    if (!UID_RE.test(uid)) return jsonResponse({ error: 'invalid uid' }, 400);
    const payload = {
      favorites: Array.isArray(body.favorites) ? body.favorites : [],
      playlists: Array.isArray(body.playlists) ? body.playlists : [],
      history:   Array.isArray(body.history)   ? body.history   : [],
      updatedAt: Date.now(),
    };
    const str = JSON.stringify(payload);
    if (str.length > 900000) return jsonResponse({ error: 'data too large' }, 413);
    await env.MUSIC_KV.put('sync:' + uid, str);
    return jsonResponse({ ok: true, updatedAt: payload.updatedAt });
  }
  return jsonResponse({ error: 'method not allowed' }, 405);
}
async function handleProxy(request, url, musicApiBase) {
  const rawTarget = url.pathname.slice('/proxy/'.length) + url.search;
  let targetUrl;
  try {
    targetUrl = new URL(decodeURIComponent(rawTarget));
  } catch {
    return new Response('Invalid proxy target URL', { status: 400 });
  }
  let musicApiHost;
  try {
    musicApiHost = new URL(musicApiBase).hostname;
  } catch {
    musicApiHost = 'music.haitangw.cc';
  }
  const allowedHosts = [
    'u.y.qq.com',
    musicApiHost,
    'y.gtimg.cn',
    'isure.stream.qqmusic.qq.com',
    'ws.stream.qqmusic.qq.com',
    'dl.stream.qqmusic.qq.com',
    'aqqmusic.tc.qq.com',
  ];
  if (!allowedHosts.some(h => targetUrl.hostname === h || targetUrl.hostname.endsWith('.' + h))) {
    return new Response('Proxy target not allowed: ' + targetUrl.hostname, { status: 403 });
  }
  const proxyHeaders = new Headers();
  proxyHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  proxyHeaders.set('Referer', 'https://y.qq.com/');
  proxyHeaders.set('Origin', 'https://y.qq.com');
  const ct = request.headers.get('Content-Type');
  if (ct) proxyHeaders.set('Content-Type', ct);
  const init = {
    method: request.method,
    headers: proxyHeaders,
    redirect: 'follow',
  };
  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = request.body;
  }
  let upstreamRes;
  try {
    upstreamRes = await fetch(targetUrl.toString(), init);
  } catch (err) {
    return new Response('Upstream fetch failed: ' + err.message, { status: 502 });
  }
  const resHeaders = new Headers(upstreamRes.headers);
  resHeaders.set('Access-Control-Allow-Origin', '*');
  resHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  resHeaders.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: resHeaders,
  });
}
function corsPreflightResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}
function buildHTML(proxyBase, siteName, musicApiBase) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
    <meta name="theme-color" content="#0f0c29">
    <title>${siteName}</title>
    <script src="https://cdn.tailwindcss.com"><\/script>
    <script src="https://unpkg.com/vue@3/dist/vue.global.js"><\/script>
    <script src="https://unpkg.com/axios/dist/axios.min.js"><\/script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,300;14..32,400;14..32,500;14..32,600;14..32,700;14..32,800&display=swap" rel="stylesheet">
    <style>
        * { font-family: 'Inter', system-ui, -apple-system, sans-serif; box-sizing: border-box; }
        body {
            background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%);
            min-height: 100vh;
            color: white;
        }
        body::before {
            content: '';
            position: fixed;
            top: 0; left: 0;
            width: 100%; height: 100%;
            background: radial-gradient(circle at 20% 50%, rgba(168,85,247,0.15) 0%, transparent 50%),
                        radial-gradient(circle at 80% 80%, rgba(236,72,153,0.1) 0%, transparent 60%);
            pointer-events: none;
            z-index: 0;
        }
        .glass-modern {
            background: rgba(15,12,41,0.6);
            backdrop-filter: blur(20px);
            border: 1px solid rgba(255,255,255,0.1);
            box-shadow: 0 8px 32px rgba(0,0,0,0.1);
            border-radius: 1.5rem;
        }
        .glass-card {
            background: rgba(255,255,255,0.05);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(255,255,255,0.08);
            transition: all 0.3s cubic-bezier(0.4,0,0.2,1);
            border-radius: 1.5rem;
        }
        .glass-card:hover {
            border-color: rgba(168,85,247,0.3);
            box-shadow: 0 8px 32px rgba(168,85,247,0.1);
        }
        @keyframes spin {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
        }
        .rotate-slow { animation: spin 20s linear infinite; }
        .song-list::-webkit-scrollbar { width: 4px; }
        .song-list::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); border-radius: 10px; }
        .song-list::-webkit-scrollbar-thumb { background: rgba(168,85,247,0.5); border-radius: 10px; }
        .song-list::-webkit-scrollbar-thumb:hover { background: rgba(168,85,247,0.8); }
        .loader {
            width: 40px; height: 40px;
            border: 3px solid rgba(168,85,247,0.3);
            border-top-color: #a855f7;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            display: inline-block;
        }
        .quality-btn {
            padding: 0.4rem 0.85rem;
            border-radius: 2rem;
            font-weight: 600;
            transition: all 0.3s;
            font-size: 0.8rem;
            white-space: nowrap;
        }
        .quality-btn-active {
            background: linear-gradient(135deg, #a855f7, #ec489a);
            box-shadow: 0 4px 15px rgba(168,85,247,0.4);
            color: white;
        }
        .song-item {
            transition: all 0.2s ease;
            cursor: pointer;
            border-radius: 0.75rem;
        }
        .song-item:hover {
            background: linear-gradient(90deg, rgba(168,85,247,0.2), rgba(236,72,153,0.1));
            transform: translateX(4px);
        }
        .song-playing {
            background: linear-gradient(90deg, rgba(168,85,247,0.3), rgba(236,72,153,0.15));
            border-left: 3px solid #a855f7;
        }
        .fade-enter-active, .fade-leave-active { transition: opacity 0.3s, transform 0.3s; }
        .fade-enter-from, .fade-leave-to { opacity: 0; transform: translate(-50%, 20px); }
        .tab-btn {
            padding: 0.6rem 1rem;
            border-radius: 1rem;
            transition: all 0.3s;
            font-weight: 600;
            color: rgba(255,255,255,0.6);
            font-size: 0.875rem;
        }
        .tab-btn.active {
            background: rgba(168,85,247,0.2);
            color: white;
            border: 1px solid rgba(168,85,247,0.3);
        }
        @media (min-width: 640px) {
            .tab-btn { padding: 0.75rem 1.5rem; font-size: 1rem; }
        }
        .modal-overlay {
            position: fixed;
            top: 0; left: 0;
            width: 100%; height: 100%;
            background: rgba(0,0,0,0.7);
            backdrop-filter: blur(5px);
            z-index: 100;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 1rem;
        }
        .control-bar {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.75rem;
            margin-bottom: 1rem;
        }
        @media (min-width: 640px) { .control-bar { gap: 1rem; } }
        .control-btn {
            width: 40px; height: 40px;
            border-radius: 50%;
            background: rgba(168,85,247,0.2);
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: all 0.2s;
            color: white;
            font-size: 18px;
            border: none;
            flex-shrink: 0;
        }
        @media (min-width: 640px) { .control-btn { width: 44px; height: 44px; font-size: 20px; } }
        .control-btn:hover { background: rgba(168,85,247,0.5); transform: scale(1.05); }
        .control-btn:disabled { opacity: 0.3; cursor: not-allowed; transform: none; }
        .control-btn-play {
            background: linear-gradient(135deg, #a855f7, #ec489a);
            width: 52px; height: 52px;
            font-size: 20px;
        }
        @media (min-width: 640px) { .control-btn-play { width: 56px; height: 56px; font-size: 22px; } }
        .control-btn-play:hover { background: linear-gradient(135deg, #9333ea, #db2777); }
        .control-btn-active {
            background: rgba(168,85,247,0.5);
            border: 1px solid rgba(168,85,247,0.6);
        }
        .progress-track {
            flex: 1; height: 6px;
            background: rgba(255,255,255,0.2);
            border-radius: 6px;
            cursor: pointer;
            position: relative;
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #a855f7, #ec489a);
            border-radius: 6px;
            position: relative;
        }
        .progress-thumb {
            width: 14px; height: 14px;
            background: white;
            border-radius: 50%;
            position: absolute;
            right: -7px; top: -4px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        }
        audio { display: none; }
        .play-queue-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #a855f7, #ec489a);
            border-radius: 0.5rem;
            padding: 2px 8px;
            font-size: 0.7rem;
            font-weight: 700;
            margin-left: 6px;
        }
        .song-index {
            width: 24px;
            text-align: center;
            font-size: 0.75rem;
            color: rgba(255,255,255,0.3);
            flex-shrink: 0;
        }
        @media (min-width: 640px) { .song-index { width: 28px; } }
        .song-index-playing { color: #a855f7; font-weight: 700; }
        .lyric-line {
            text-align: center;
            padding: 0.4rem 0.5rem;
            font-size: 0.85rem;
            color: rgba(255,255,255,0.3);
            transition: all 0.35s ease;
            line-height: 1.65;
            border-radius: 0.5rem;
        }
        .lyric-line-active {
            color: white;
            font-size: 0.95rem;
            font-weight: 600;
            background: linear-gradient(90deg, rgba(168,85,247,0.18), rgba(236,72,153,0.1));
        }
        @media (min-width: 1024px) {
            .layout-wrapper {
                max-width: 640px;
                margin: 0 auto;
            }
        }
        .now-playing-mini-bar-desktop {
            display: none;
        }
        @media (min-width: 1024px) {
            .now-playing-mini-bar-desktop {
                display: flex;
                position: fixed;
                bottom: 1.5rem;
                left: 50%;
                transform: translateX(-50%);
                width: 100%;
                max-width: 640px;
                z-index: 50;
                cursor: pointer;
                align-items: center;
                gap: 0.75rem;
                padding: 0.6rem 1rem;
                border-radius: 1rem;
            }
        }
        .mini-player {
            position: fixed;
            bottom: 0; left: 0; right: 0;
            z-index: 50;
            background: rgba(15,12,41,0.95);
            backdrop-filter: blur(20px);
            border-top: 1px solid rgba(168,85,247,0.3);
            padding: 0.6rem 1rem;
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }
        .mini-player-info { flex: 1; min-width: 0; }
        .mini-player-prog {
            position: absolute;
            top: 0; left: 0; right: 0;
            height: 2px;
            background: rgba(255,255,255,0.15);
        }
        .mini-player-prog-fill {
            height: 100%;
            background: linear-gradient(90deg, #a855f7, #ec489a);
            transition: width 0.5s linear;
        }
        .tablet-player {
            display: none;
        }
        @media (min-width: 640px) and (max-width: 1023px) {
            .tablet-player {
                display: block;
                position: fixed;
                bottom: 0; left: 0; right: 0;
                z-index: 50;
                background: rgba(10,8,35,0.97);
                backdrop-filter: blur(24px);
                border-top: 1px solid rgba(168,85,247,0.35);
                padding: 0 1.5rem;
            }
            .tablet-player-inner {
                display: flex;
                align-items: center;
                gap: 1rem;
                height: 72px;
            }
            .tablet-player-art {
                width: 48px; height: 48px;
                border-radius: 10px;
                object-fit: cover;
                flex-shrink: 0;
            }
            .tablet-player-info {
                flex: 1;
                min-width: 0;
            }
            .tablet-player-controls {
                display: flex;
                align-items: center;
                gap: 0.5rem;
                flex-shrink: 0;
            }
            .tablet-player-prog {
                position: absolute;
                top: 0; left: 0; right: 0;
                height: 2px;
                background: rgba(255,255,255,0.1);
                cursor: pointer;
            }
            .tablet-player-prog-fill {
                height: 100%;
                background: linear-gradient(90deg, #a855f7, #ec489a);
                transition: width 0.5s linear;
                pointer-events: none;
            }
        }
        .player-inline { display: none; }
        .player-mini   { display: flex; }
        @media (min-width: 640px) {
            .player-inline { display: block; }
            .player-mini   { display: none; }
        }
        @media (min-width: 640px) and (max-width: 1023px) {
            .player-inline { display: none; }
        }
        @media (max-width: 639px) {
            .page-bottom-padding { padding-bottom: 80px; }
        }
        @media (min-width: 640px) and (max-width: 1023px) {
            .page-bottom-padding { padding-bottom: 120px; }
        }

        @media (max-width: 479px) {
            .song-actions-extra { display: none; }
        }
        @media (min-width: 1024px) {
            .song-list-desktop { max-height: calc(100vh - 280px) !important; }
        }
        .lyrics-panel-inline {
            max-height: 220px;
            overflow-y: auto;
            padding: 0.25rem 0.5rem;
            scroll-behavior: smooth;
            margin-top: 0.75rem;
            border-top: 1px solid rgba(255,255,255,0.08);
        }
        .lyrics-panel-inline::-webkit-scrollbar { width: 3px; }
        .lyrics-panel-inline::-webkit-scrollbar-track { background: transparent; }
        .lyrics-panel-inline::-webkit-scrollbar-thumb { background: rgba(168,85,247,0.4); border-radius: 10px; }
        .floating-lyric-bar {
            position: fixed;
            left: 0; right: 0;
            z-index: 49;
            background: rgba(15,12,41,0.92);
            backdrop-filter: blur(16px);
            text-align: center;
            font-weight: 500;
            letter-spacing: 0.02em;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            transition: opacity 0.3s, transform 0.3s;
            border-top: 1px solid rgba(168,85,247,0.25);
        }
        @media (max-width: 639px) {
            .floating-lyric-bar {
                bottom: 64px;
                padding: 0.45rem 1.25rem;
                font-size: 0.82rem;
                color: rgba(255,255,255,0.85);
            }
        }
        @media (min-width: 640px) and (max-width: 1023px) {
            .floating-lyric-bar {
                bottom: 72px;
                padding: 0.55rem 2.5rem;
                font-size: 0.92rem;
                color: rgba(255,255,255,0.9);
                background: linear-gradient(
                    90deg,
                    rgba(15,12,41,0.94) 0%,
                    rgba(30,20,60,0.96) 40%,
                    rgba(30,20,60,0.96) 60%,
                    rgba(15,12,41,0.94) 100%
                );
            }
        }
        @media (min-width: 1024px) {
            .floating-lyric-bar { display: none !important; }
        }
        .now-playing-art-wrap {
            width: 240px; height: 240px;
            margin: 0 auto 1rem;
            cursor: pointer;
            perspective: 1200px;
        }
        .now-playing-flip-inner {
            position: relative;
            width: 100%; height: 100%;
            transform-style: preserve-3d;
            transition: transform 0.6s cubic-bezier(0.4, 0.15, 0.2, 1);
        }
        .now-playing-flip-inner.flipped {
            transform: rotateY(180deg);
        }
        .now-playing-face {
            position: absolute;
            top: 0; left: 0;
            width: 100%; height: 100%;
            backface-visibility: hidden;
            -webkit-backface-visibility: hidden;
        }
        .now-playing-face-back {
            transform: rotateY(180deg);
        }
        .now-playing-art {
            width: 240px; height: 240px;
            border-radius: 1.25rem;
            object-fit: cover;
            box-shadow: 0 12px 40px rgba(0,0,0,0.35);
        }
        .now-playing-lyrics-face {
            width: 240px; height: 240px;
            border-radius: 1.25rem;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.12);
            box-shadow: 0 12px 40px rgba(0,0,0,0.25);
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 1rem;
            overflow: hidden;
        }
        .now-playing-lyrics-scroll {
            max-height: 100%;
            overflow-y: auto;
            width: 100%;
            scroll-behavior: smooth;
        }
        .now-playing-lyrics-scroll::-webkit-scrollbar { width: 3px; }
        .now-playing-lyrics-scroll::-webkit-scrollbar-track { background: transparent; }
        .now-playing-lyrics-scroll::-webkit-scrollbar-thumb { background: rgba(168,85,247,0.4); border-radius: 10px; }
        .lockscreen-badge {
            display: inline-flex;
            align-items: center;
            gap: 0.35rem;
            font-size: 0.7rem;
            font-weight: 600;
            padding: 0.2rem 0.6rem;
            border-radius: 2rem;
            background: rgba(168,85,247,0.25);
            border: 1px solid rgba(168,85,247,0.4);
            color: rgba(200,160,255,0.9);
        }
        .lockscreen-badge-dot {
            width: 6px; height: 6px;
            border-radius: 50%;
            background: #a855f7;
            animation: pulse-dot 1.8s ease-in-out infinite;
        }
        @keyframes pulse-dot {
            0%,100% { opacity: 1; transform: scale(1); }
            50%      { opacity: 0.4; transform: scale(0.7); }
        }
    </style>
</head>
<body>
<div id="app" class="relative z-10 max-w-[1400px] mx-auto px-3 sm:px-4 lg:px-6 py-4 sm:py-6 lg:py-8 page-bottom-padding">
    <div class="text-center mb-5 sm:mb-8 layout-main">
        <h1 class="text-3xl sm:text-4xl lg:text-5xl font-bold bg-gradient-to-r from-purple-400 via-pink-500 to-purple-400 bg-clip-text text-transparent inline-block">
            ${siteName}
        </h1>
        <p class="text-white/60 text-xs sm:text-sm mt-2">母带级音质 · 随心收藏 · 自由列表</p>
    </div>
    <div class="layout-wrapper">
    <div class="layout-main" :class="desktopPage==='player' ? 'lg:hidden' : ''">
    <div class="flex justify-center gap-2 sm:gap-4 mb-5 sm:mb-8 flex-wrap">
        <button @click="switchTab('search')" :class="{active: currentTab==='search'}" class="tab-btn">🔍 搜索</button>
        <button @click="switchTab('favorites')" :class="{active: currentTab==='favorites'}" class="tab-btn">
            ❤️ 收藏<span v-if="favorites.length" class="play-queue-badge">{{ favorites.length }}</span>
        </button>
        <button @click="switchTab('playlists')" :class="{active: currentTab==='playlists'}" class="tab-btn">
            📁 列表<span v-if="playlists.length" class="play-queue-badge">{{ playlists.length }}</span>
        </button>
        <button @click="switchTab('history')" :class="{active: currentTab==='history'}" class="tab-btn">
            🕓 历史<span v-if="history.length" class="play-queue-badge">{{ history.length }}</span>
        </button>
        <button @click="showSyncModal=true" class="tab-btn">
            🔗 同步<span v-if="syncStatus==='error'" class="play-queue-badge !bg-red-500">!</span>
        </button>
    </div>
    <div v-if="currentTab==='search'">
        <div class="glass-modern p-3 sm:p-5 mb-4 sm:mb-6">
            <div class="flex flex-wrap gap-2">
                <button v-for="q in qualities" :key="q.value"
                    @click="currentQuality=q.value; if(currentSong) refreshPlay()"
                    class="quality-btn"
                    :class="currentQuality===q.value ? 'quality-btn-active' : 'bg-white/10 text-white/70'">
                    {{ q.label }}
                </button>
            </div>
        </div>
        <div class="glass-modern p-4 sm:p-6 mb-4 sm:mb-6">
            <div class="flex flex-col sm:flex-row gap-3 mb-4">
                <input v-model="keyword" @keyup.enter="searchMusic" type="text"
                    placeholder="输入歌名、歌手..."
                    class="flex-1 px-4 sm:px-6 py-3 rounded-xl bg-white/10 border border-white/20 text-white outline-none focus:border-purple-500 text-sm sm:text-base">
                <button @click="searchMusic" :disabled="loading"
                    class="bg-gradient-to-r from-purple-600 to-pink-600 px-6 sm:px-8 py-3 rounded-xl font-semibold flex items-center justify-center gap-2 text-sm sm:text-base">
                    <span v-if="loading" class="loader w-4 h-4 border-2"></span>
                    <span>{{ loading ? '搜索中' : '搜索音乐' }}</span>
                </button>
            </div>
            <div class="flex flex-wrap gap-2">
                <span v-for="tag in quickTags" :key="tag" @click="keyword=tag; searchMusic()"
                    class="px-3 sm:px-4 py-1.5 sm:py-2 rounded-full bg-white/10 text-xs sm:text-sm cursor-pointer hover:bg-purple-500/40">
                    # {{ tag }}
                </span>
            </div>
        </div>
    </div>
    <div v-if="currentTab==='favorites'" class="glass-modern p-4 sm:p-6 mb-4 sm:mb-6">
        <div class="flex flex-wrap justify-between items-center mb-4 gap-3">
            <h2 class="text-lg sm:text-xl font-bold">❤️ 我的收藏 ({{ favorites.length }})</h2>
            <div v-if="favorites.length" class="flex gap-2">
                <button @click="playAll(favorites)" class="bg-purple-600/40 hover:bg-purple-600/70 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all">▶ 全部播放</button>
                <button @click="playShuffle(favorites)" class="bg-pink-600/30 hover:bg-pink-600/50 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all">🔀 随机播放</button>
            </div>
        </div>
        <div v-if="!favorites.length" class="text-white/40 text-center py-10">暂无收藏，快去搜索喜欢的歌吧</div>
    </div>
    <div v-if="currentTab==='history'" class="glass-modern p-4 sm:p-6 mb-4 sm:mb-6">
        <div class="flex flex-wrap justify-between items-center mb-4 gap-3">
            <h2 class="text-lg sm:text-xl font-bold">🕓 播放历史 ({{ history.length }})</h2>
            <div v-if="history.length" class="flex gap-2">
                <button @click="playAll(history)" class="bg-purple-600/40 hover:bg-purple-600/70 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all">▶ 全部播放</button>
                <button @click="clearHistory" class="bg-white/10 hover:bg-red-500/40 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all">🗑️ 清空</button>
            </div>
        </div>
        <div v-if="!history.length" class="text-white/40 text-center py-10">暂无播放记录，听点什么吧</div>
    </div>
    <div v-if="currentTab==='playlists'" class="glass-modern p-4 sm:p-6 mb-4 sm:mb-6">
        <div v-if="!currentPlaylist">
            <div class="flex justify-between items-center mb-5">
                <h2 class="text-lg sm:text-xl font-bold">📁 播放列表 ({{ playlists.length }})</h2>
                <button @click="showCreatePlaylist=true" class="bg-purple-600/40 hover:bg-purple-600/60 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm transition-all">+ 新建列表</button>
            </div>
            <div v-if="!playlists.length" class="text-white/40 text-center py-10">暂无播放列表</div>
            <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                <div v-for="(pl, idx) in playlists" :key="idx" class="glass-card p-3 sm:p-4 flex justify-between items-center">
                    <div @click="openPlaylist(pl)" class="cursor-pointer flex-1 min-w-0">
                        <div class="font-bold truncate">{{ pl.name }}</div>
                        <div class="text-xs text-white/50">{{ pl.songs.length }} 首歌曲</div>
                    </div>
                    <div class="flex items-center gap-1 flex-shrink-0">
                        <button v-if="pl.songs.length" @click.stop="playAll(pl.songs)" class="text-purple-400 hover:text-purple-300 p-2" title="播放全部">▶</button>
                        <button @click.stop="deletePlaylist(idx)" class="text-white/30 hover:text-red-400 p-2">🗑️</button>
                    </div>
                </div>
            </div>
        </div>
        <div v-else>
            <div class="flex flex-wrap justify-between items-center mb-4 gap-3">
                <div class="flex items-center gap-2 sm:gap-3">
                    <button @click="currentPlaylist=null" class="w-9 h-9 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 transition-all text-lg">←</button>
                    <h2 class="text-lg sm:text-xl font-bold truncate">{{ currentPlaylist.name }}
                        <span class="text-sm text-white/40 font-normal ml-2">{{ currentPlaylist.songs.length }} 首</span>
                    </h2>
                </div>
                <div v-if="currentPlaylist.songs.length" class="flex gap-2">
                    <button @click="playAll(currentPlaylist.songs)" class="bg-purple-600/40 hover:bg-purple-600/70 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all">▶ 全部播放</button>
                    <button @click="playShuffle(currentPlaylist.songs)" class="bg-pink-600/30 hover:bg-pink-600/50 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all">🔀 随机</button>
                </div>
            </div>
            <div v-if="!currentPlaylist.songs.length" class="text-white/40 text-center py-10">列表为空，去搜索并添加歌曲吧</div>
        </div>
    </div>
    <div v-if="displaySongs.length" class="glass-modern p-3 sm:p-4 mb-4 sm:mb-6 max-h-[420px] sm:max-h-[500px] overflow-y-auto song-list song-list-desktop">
        <div v-for="(song, idx) in displaySongs" :key="song.id"
            class="song-item p-2 sm:p-3 flex items-center gap-2 sm:gap-3 mb-1"
            :class="{'song-playing': currentSong?.id===song.id}">
            <div class="song-index" :class="{'song-index-playing': currentSong?.id===song.id}">
                <span v-if="currentSong?.id===song.id">♫</span>
                <span v-else>{{ idx+1 }}</span>
            </div>
            <img :src="song.artwork" class="w-10 h-10 sm:w-12 sm:h-12 rounded-lg object-cover flex-shrink-0" @click="playSong(song)">
            <div class="flex-1 min-w-0" @click="playSong(song)">
                <div class="font-semibold truncate text-sm sm:text-base">{{ song.title }}</div>
                <div class="text-xs text-white/50 truncate">{{ song.artist }}</div>
            </div>
            <div class="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
                <button @click="toggleFavorite(song)" class="p-1.5 sm:p-2 hover:scale-110 transition-all text-base">{{ isFavorite(song)?'❤️':'🤍' }}</button>
                <button @click="showAddToPlaylist(song)" class="p-1.5 sm:p-2 hover:scale-110 transition-all song-actions-extra text-base">➕</button>
                <button v-if="currentPlaylist && currentTab==='playlists'" @click="removeFromPlaylist(song)" class="p-1.5 sm:p-2 text-white/30 hover:text-red-400 transition-all text-base">❌</button>
            </div>
        </div>
    </div>
    </div>
    <div class="layout-sidebar hidden" :class="desktopPage==='player' ? 'lg:block' : 'lg:hidden'">
        <div v-if="currentSong" class="now-playing-panel">
            <div class="glass-card p-6 text-center">
                <div @click="backToList" class="flex items-center gap-1.5 text-white/50 hover:text-white/80 cursor-pointer text-sm mb-4 transition-colors" style="width: fit-content;">
                    <span>←</span><span>返回列表</span>
                </div>
                <div class="now-playing-art-wrap" @click="toggleLyrics">
                    <div class="now-playing-flip-inner" :class="{flipped: showLyrics}">
                        <img :src="currentSong.artwork" class="now-playing-art now-playing-face now-playing-face-front rotate-slow">
                        <div class="now-playing-lyrics-face now-playing-face now-playing-face-back">
                            <div v-if="loadingLyrics" class="flex items-center justify-center"><span class="loader"></span></div>
                            <div v-else-if="lyricsError" @click.stop="fetchLyrics" class="text-white/40 text-sm text-center cursor-pointer hover:text-white/70">
                                ⚠ 获取失败<br><span class="text-xs underline">点击重试</span>
                            </div>
                            <div v-else-if="!lyrics.length" class="text-white/30 text-sm">暂无歌词</div>
                            <div v-else ref="lyricsContainerSidebar" class="now-playing-lyrics-scroll">
                                <div v-for="(line, i) in lyrics" :key="i"
                                    :class="['lyric-line', i===currentLyricIdx ? 'lyric-line-active' : '']">
                                    {{ line.text }}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <p class="text-[11px] text-white/30 mb-3">点击封面{{ showLyrics ? '返回封面' : '查看歌词' }}</p>
                <div class="flex items-center justify-center gap-2 flex-wrap mb-1">
                    <h2 class="text-xl font-bold truncate max-w-full">{{ currentSong.title }}</h2>
                </div>
                <p class="text-white/60 text-sm mb-2">{{ currentSong.artist }}</p>
                <div class="flex items-center justify-center gap-2 flex-wrap mb-4">
                    <span v-if="playQueue.length" class="text-xs text-white/40">队列 {{ currentQueueIndex+1 }} / {{ playQueue.length }}</span>
                    <span v-if="isShuffle" class="text-xs bg-pink-500/20 text-pink-300 px-2 py-0.5 rounded-full">随机</span>
                    <span v-if="isLoop" class="text-xs bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded-full">单曲循环</span>
                    <span v-if="mediaSessionActive" class="lockscreen-badge">
                        <span class="lockscreen-badge-dot"></span>锁屏歌词
                    </span>
                </div>
                <div class="control-bar">
                    <button @click="toggleShuffle" class="control-btn text-base" :class="{'control-btn-active': isShuffle}" title="随机播放">🔀</button>
                    <button @click="playPrev" class="control-btn" :disabled="!hasPrev">⏮</button>
                    <button @click="togglePlay" class="control-btn control-btn-play">{{ isPlaying?'⏸':'▶' }}</button>
                    <button @click="playNext" class="control-btn" :disabled="!hasNext">⏭</button>
                    <button @click="toggleLoop" class="control-btn text-base" :class="{'control-btn-active': isLoop}" title="单曲循环">🔁</button>
                </div>
                <div class="flex items-center gap-3">
                    <span class="text-xs font-mono opacity-50">{{ currentTime }}</span>
                    <div class="progress-track" @click="seek">
                        <div class="progress-fill" :style="{width: progressPercent+'%'}">
                            <div class="progress-thumb"></div>
                        </div>
                    </div>
                    <span class="text-xs font-mono opacity-50">{{ duration }}</span>
                </div>
                <div class="flex gap-2 mt-4">
                    <button @click="downloadSong" :disabled="downloading"
                        class="flex-1 bg-green-600/40 hover:bg-green-600/60 py-2 rounded-lg text-xs sm:text-sm font-bold flex items-center justify-center gap-2 transition-all">
                        <span v-if="downloading" class="loader w-4 h-4 border-2"></span>
                        <span>{{ downloading?'下载中...':'下载歌曲' }}</span>
                    </button>
                    <button @click="toggleFavorite(currentSong)"
                        class="px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-bold transition-all"
                        :class="isFavorite(currentSong)?'bg-pink-600/40 hover:bg-pink-600/60':'bg-white/10 hover:bg-white/20'">
                        {{ isFavorite(currentSong)?'❤️ 已收藏':'🤍 收藏' }}
                    </button>
                </div>
            </div>
        </div>
    </div>
    </div>
    <div v-if="currentSong && showLyrics && lyrics.length && currentLyricIdx >= 0"
         class="floating-lyric-bar">
        <span class="opacity-40 mr-2 text-xs">🎤</span>{{ lyrics[currentLyricIdx]?.text }}
    </div>
    <div v-if="currentSong" class="mini-player player-mini">
        <div class="mini-player-prog">
            <div class="mini-player-prog-fill" :style="{width: progressPercent+'%'}"></div>
        </div>
        <img :src="currentSong.artwork" class="w-11 h-11 rounded-lg object-cover flex-shrink-0">
        <div class="mini-player-info">
            <div class="font-semibold truncate text-sm">{{ currentSong.title }}</div>
            <div class="text-xs text-white/50 truncate">{{ currentSong.artist }}</div>
        </div>
        <button @click="playPrev" class="control-btn !w-9 !h-9 !text-sm" :disabled="!hasPrev">⏮</button>
        <button @click="togglePlay" class="control-btn control-btn-play !w-11 !h-11 !text-lg">{{ isPlaying?'⏸':'▶' }}</button>
        <button @click="playNext" class="control-btn !w-9 !h-9 !text-sm" :disabled="!hasNext">⏭</button>
        <button @click="toggleLyrics" class="control-btn !w-9 !h-9 !text-xs font-bold" :class="{'control-btn-active': showLyrics}" title="歌词">词</button>
    </div>
    <div v-if="currentSong" class="tablet-player">
        <div class="tablet-player-prog" @click="seekFromTabletBar">
            <div class="tablet-player-prog-fill" :style="{width: progressPercent+'%'}"></div>
        </div>
        <div class="tablet-player-inner">
            <img :src="currentSong.artwork" class="tablet-player-art">
            <div class="tablet-player-info">
                <div class="font-semibold truncate text-sm">{{ currentSong.title }}</div>
                <div class="text-xs text-white/50 truncate">{{ currentSong.artist }}</div>
                <div class="flex items-center gap-2 mt-0.5">
                    <span class="text-xs font-mono opacity-40">{{ currentTime }}</span>
                    <span class="text-xs opacity-20">/</span>
                    <span class="text-xs font-mono opacity-40">{{ duration }}</span>
                    <span v-if="isShuffle" class="text-xs bg-pink-500/20 text-pink-300 px-1.5 py-0.5 rounded-full">随机</span>
                    <span v-if="isLoop" class="text-xs bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded-full">循环</span>
                    <span v-if="mediaSessionActive" class="lockscreen-badge">
                        <span class="lockscreen-badge-dot"></span>锁屏歌词
                    </span>
                </div>
            </div>
            <div class="tablet-player-controls">
                <button @click="toggleShuffle" class="control-btn !w-9 !h-9 !text-sm" :class="{'control-btn-active': isShuffle}" title="随机">🔀</button>
                <button @click="playPrev" class="control-btn !w-9 !h-9" :disabled="!hasPrev">⏮</button>
                <button @click="togglePlay" class="control-btn control-btn-play !w-12 !h-12 !text-xl">{{ isPlaying?'⏸':'▶' }}</button>
                <button @click="playNext" class="control-btn !w-9 !h-9" :disabled="!hasNext">⏭</button>
                <button @click="toggleLoop" class="control-btn !w-9 !h-9 !text-sm" :class="{'control-btn-active': isLoop}" title="循环">🔁</button>
                <button @click="toggleLyrics" class="control-btn !w-9 !h-9 !text-xs font-bold" :class="{'control-btn-active': showLyrics}" title="歌词">词</button>
                <button @click="toggleFavorite(currentSong)" class="control-btn !w-9 !h-9 !text-base">{{ isFavorite(currentSong)?'❤️':'🤍' }}</button>
                <button @click="downloadSong" :disabled="downloading" class="control-btn !w-9 !h-9 !text-sm" title="下载">
                    <span v-if="downloading" class="loader !w-4 !h-4 !border-2"></span>
                    <span v-else>⬇</span>
                </button>
            </div>
        </div>
    </div>
    <div v-if="currentSong && desktopPage==='list'" class="now-playing-mini-bar-desktop glass-card" @click="desktopPage='player'">
        <img :src="currentSong.artwork" class="w-9 h-9 rounded-lg object-cover flex-shrink-0">
        <div class="flex-1 min-w-0">
            <div class="font-semibold truncate text-sm">{{ currentSong.title }}</div>
            <div class="text-xs text-white/50 truncate">{{ currentSong.artist }}</div>
        </div>
        <button @click.stop="togglePlay" class="control-btn !w-9 !h-9 !text-sm">{{ isPlaying?'⏸':'▶' }}</button>
        <span class="text-white/30 text-sm">⌃</span>
    </div>
    <transition name="fade">
        <div v-if="message" class="fixed bottom-24 sm:bottom-24 left-1/2 -translate-x-1/2 bg-black/80 backdrop-blur px-5 py-3 rounded-full text-sm z-[200] border border-white/10 whitespace-nowrap">
            {{ message }}
        </div>
    </transition>
    <div v-if="showCreatePlaylist" class="modal-overlay" @click.self="showCreatePlaylist=false">
        <div class="glass-modern p-5 sm:p-6 w-full max-w-md">
            <h3 class="text-lg sm:text-xl font-bold mb-4">新建播放列表</h3>
            <input v-model="newPlaylistName" @keyup.enter="createPlaylist" type="text" placeholder="输入列表名称..."
                class="w-full bg-white/10 border border-white/20 p-3 rounded-xl mb-4 outline-none focus:border-purple-500 text-white text-base">
            <div class="flex gap-3">
                <button @click="createPlaylist" class="flex-1 bg-purple-600 hover:bg-purple-700 py-3 rounded-xl font-bold transition-all">创建</button>
                <button @click="showCreatePlaylist=false" class="flex-1 bg-white/10 hover:bg-white/20 py-3 rounded-xl transition-all">取消</button>
            </div>
        </div>
    </div>
    <div v-if="songToPlaylist" class="modal-overlay" @click.self="songToPlaylist=null">
        <div class="glass-modern p-5 sm:p-6 w-full max-w-md">
            <h3 class="text-lg sm:text-xl font-bold mb-1">添加到列表</h3>
            <p class="text-white/50 text-sm mb-4 truncate">{{ songToPlaylist.title }}</p>
            <div class="max-h-60 overflow-y-auto mb-4">
                <div v-for="(pl, idx) in playlists" :key="idx" @click="addToPlaylist(pl)"
                    class="p-3 hover:bg-white/10 rounded-lg cursor-pointer flex justify-between items-center transition-all">
                    <span>{{ pl.name }}</span>
                    <span class="text-white/40 text-sm">{{ pl.songs.length }} 首</span>
                </div>
                <div v-if="!playlists.length" class="text-center py-4 text-white/40">暂无列表，请先创建</div>
            </div>
            <button @click="songToPlaylist=null" class="w-full bg-white/10 hover:bg-white/20 py-3 rounded-xl transition-all">关闭</button>
        </div>
    </div>
    <div v-if="showSyncModal" class="modal-overlay" @click.self="showSyncModal=false">
        <div class="glass-modern p-5 sm:p-6 w-full max-w-md">
            <h3 class="text-lg sm:text-xl font-bold mb-1">🔗 多端同步</h3>
            <p class="text-white/50 text-sm mb-4">在其他设备上打开本站，输入下面的同步码，即可同步收藏、播放列表与播放历史。</p>
            <div class="bg-white/10 rounded-xl p-4 flex items-center justify-between mb-2">
                <span class="font-mono text-lg tracking-widest">{{ syncId }}</span>
                <button @click="copySyncCode" class="bg-purple-600/50 hover:bg-purple-600/70 px-3 py-1.5 rounded-lg text-xs font-semibold flex-shrink-0">复制</button>
            </div>
            <div class="text-xs mb-4" :class="syncStatus==='error' ? 'text-red-400' : 'text-white/40'">
                <span v-if="syncStatus==='syncing'">⏳ 同步中…</span>
                <span v-else-if="syncStatus==='error'">⚠ 同步失败，请检查网络或确认已绑定 KV 存储</span>
                <span v-else>✓ 已与云端同步</span>
            </div>
            <div class="border-t border-white/10 pt-4">
                <p class="text-white/50 text-sm mb-2">已有同步码？输入即可切换到该设备的数据：</p>
                <div class="flex gap-2">
                    <input v-model="syncCodeInput" @keyup.enter="switchSyncCode" type="text" placeholder="输入同步码"
                        class="flex-1 min-w-0 bg-white/10 border border-white/20 p-2.5 rounded-xl outline-none focus:border-purple-500 text-white text-sm font-mono uppercase">
                    <button @click="switchSyncCode" class="bg-purple-600 hover:bg-purple-700 px-4 rounded-xl text-sm font-bold transition-all flex-shrink-0">切换</button>
                </div>
            </div>
            <button @click="showSyncModal=false" class="w-full bg-white/10 hover:bg-white/20 py-3 rounded-xl transition-all mt-4">关闭</button>
        </div>
    </div>
    <audio v-if="currentSong" ref="audioPlayer" :src="currentPlayUrl"
        @loadedmetadata="onLoaded" @timeupdate="onTimeUpdate" @ended="onEnded" style="display:none"></audio>
</div>
<script>
const { createApp, ref, computed, watch, nextTick } = Vue;
const PROXY = '${proxyBase}';
const MUSIC_API_BASE = '${musicApiBase}';
const defaultCover = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000000MkMni19ClKG.jpg';
const MS = ('mediaSession' in navigator) ? navigator.mediaSession : null;
function msSetMetadata(song, lyricsArr) {
    if (!MS) return;
    const artworkSrc = song.artwork || defaultCover;
    const meta = {
        title:   song.title,
        artist:  song.artist,
        artwork: [
            { src: artworkSrc, sizes: '96x96',   type: 'image/jpeg' },
            { src: artworkSrc, sizes: '512x512',  type: 'image/jpeg' },
            { src: artworkSrc, sizes: '800x800',  type: 'image/jpeg' },
        ],
    };
    if (lyricsArr && lyricsArr.length) {
        try {
            meta.chapterInfo = lyricsArr.map(l => ({
                startTime: l.time,
                title: l.text,
            }));
        } catch (e) { /* browser doesn't support chapterInfo — silently skip */ }
    }
    try {
        navigator.mediaSession.metadata = new MediaMetadata(meta);
    } catch (e) {}
}
function msSetPositionState(audio) {
    if (!MS || !audio || !isFinite(audio.duration) || audio.duration === 0) return;
    try {
        MS.setPositionState({
            duration:     audio.duration,
            playbackRate: audio.playbackRate || 1,
            position:     Math.min(audio.currentTime, audio.duration),
        });
    } catch (e) {}
}
createApp({
    setup() {
        const currentTab        = ref('search');
        const keyword           = ref('');
        const songs             = ref([]);
        const loading           = ref(false);
        const currentSong       = ref(null);
        const currentPlayUrl    = ref('');
        const message           = ref('');
        const downloading       = ref(false);
        const currentQuality    = ref('standard');
        const audioPlayer       = ref(null);
        const isPlaying         = ref(false);
        const isLoop            = ref(false);
        const isShuffle         = ref(false);
        const currentTime       = ref('00:00');
        const duration          = ref('00:00');
        const progressPercent   = ref(0);
        const playQueue         = ref([]);
        const currentQueueIndex = ref(-1);
        const favorites         = ref(JSON.parse(localStorage.getItem('otc_favs') || '[]'));
        const playlists         = ref(JSON.parse(localStorage.getItem('otc_pls')  || '[]'));
        const history            = ref(JSON.parse(localStorage.getItem('otc_history') || '[]'));
        const showSyncModal      = ref(false);
        const desktopPage        = ref('list'); // 'list' | 'player' — 桌面端单栏分页
        const backToList = () => { desktopPage.value = 'list'; };
        const syncCodeInput      = ref('');
        const syncStatus         = ref('idle'); // idle | syncing | synced | error
        const genSyncId = () => {
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            let s = '';
            for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
            return s;
        };
        const syncId = ref(localStorage.getItem('otc_uid') || '');
        if (!syncId.value) {
            syncId.value = genSyncId();
            localStorage.setItem('otc_uid', syncId.value);
        }
        const currentPlaylist   = ref(null);
        const showCreatePlaylist  = ref(false);
        const newPlaylistName     = ref('');
        const songToPlaylist      = ref(null);
        const showLyrics          = ref(false);
        const lyrics              = ref([]);
        const currentLyricIdx     = ref(-1);
        const loadingLyrics       = ref(false);
        const lyricsError         = ref(false);
        const lyricsContainerSidebar = ref(null);
        const mediaSessionActive  = ref(false);  // shown as "锁屏歌词" badge
        const qualities  = [
            { value: 'low',      label: '标准'  },
            { value: 'standard', label: '高品质' },
            { value: 'high',     label: '无损'   },
        ];
        const quickTags = ['晴天','夜曲','起风了','周杰伦','陈奕迅','邓紫棋'];
        const parseLrc = lrcStr => {
            const result = [];
            for (const line of lrcStr.split('\\n')) {
                const m = line.match(/\\[(\\d{2}):(\\d{2}(?:\\.\\d+)?)\\](.*)/);
                if (m) {
                    const time = parseInt(m[1]) * 60 + parseFloat(m[2]);
                    const text = m[3].trim();
                    if (text) result.push({ time, text });
                }
            }
            return result.sort((a, b) => a.time - b.time);
        };
        const registerMediaSessionHandlers = () => {
            if (!MS) return;
            MS.setActionHandler('play',  () => { audioPlayer.value?.play(); isPlaying.value = true; MS.playbackState = 'playing'; });
            MS.setActionHandler('pause', () => { audioPlayer.value?.pause(); isPlaying.value = false; MS.playbackState = 'paused'; });
            MS.setActionHandler('previoustrack', () => playPrev());
            MS.setActionHandler('nexttrack',     () => playNext());
            MS.setActionHandler('seekto', details => {
                if (audioPlayer.value && details.seekTime != null) {
                    audioPlayer.value.currentTime = details.seekTime;
                    msSetPositionState(audioPlayer.value);
                }
            });
            MS.setActionHandler('seekforward', details => {
                if (audioPlayer.value) {
                    audioPlayer.value.currentTime = Math.min(
                        audioPlayer.value.currentTime + (details.seekOffset || 10),
                        audioPlayer.value.duration
                    );
                    msSetPositionState(audioPlayer.value);
                }
            });
            MS.setActionHandler('seekbackward', details => {
                if (audioPlayer.value) {
                    audioPlayer.value.currentTime = Math.max(
                        audioPlayer.value.currentTime - (details.seekOffset || 10),
                        0
                    );
                    msSetPositionState(audioPlayer.value);
                }
            });
        };
        const pushMediaSession = (lyricsArr) => {
            if (!MS || !currentSong.value) return;
            msSetMetadata(currentSong.value, lyricsArr || lyrics.value);
            MS.playbackState = isPlaying.value ? 'playing' : 'paused';
            mediaSessionActive.value = !!MS;
        };
        const fetchLyrics = async () => {
            if (!currentSong.value) return;
            loadingLyrics.value = true;
            lyricsError.value = false;
            lyrics.value = [];
            currentLyricIdx.value = -1;
            try {
                const res = await axios.get('/api/lyrics', {
                    params: { songmid: currentSong.value.songmid, songid: currentSong.value.id },
                });
                const raw = res.data?.lyric || '';
                let lrcStr = raw;
                if (raw && !raw.includes('[')) {
                    try {
                        const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
                        lrcStr = new TextDecoder('utf-8').decode(bytes);
                    } catch { lrcStr = raw; }
                }
                lyrics.value = parseLrc(lrcStr);
                if (!lyrics.value.length) {
                    showMsg('暂无歌词');
                } else {
                    pushMediaSession(lyrics.value);
                }
            } catch (err) {
                lyricsError.value = true;
                showMsg('歌词获取失败');
            }
            finally { loadingLyrics.value = false; }
        };
        const toggleLyrics = () => {
            showLyrics.value = !showLyrics.value;
            if (showLyrics.value && !lyrics.value.length && !loadingLyrics.value) fetchLyrics();
        };
        let saveTimer = null;
        const saveToCloud = () => {
            return axios.post('/api/sync', {
                uid: syncId.value,
                favorites: favorites.value,
                playlists: playlists.value,
                history: history.value,
            }).then(() => { syncStatus.value = 'synced'; })
              .catch(() => { syncStatus.value = 'error'; });
        };
        const scheduleSave = () => {
            syncStatus.value = 'syncing';
            clearTimeout(saveTimer);
            saveTimer = setTimeout(saveToCloud, 900);
        };
        const loadFromCloud = async uid => {
            syncStatus.value = 'syncing';
            try {
                const res = await axios.get('/api/sync?uid=' + encodeURIComponent(uid));
                const data = res.data || {};
                if (data.updatedAt) {
                    favorites.value = data.favorites || [];
                    playlists.value = data.playlists || [];
                    history.value   = data.history   || [];
                    syncStatus.value = 'synced';
                } else {
                    await saveToCloud();
                }
            } catch { syncStatus.value = 'error'; }
        };
        const switchSyncCode = async () => {
            const code = syncCodeInput.value.trim().toUpperCase();
            if (!code) return;
            if (!/^[A-Za-z0-9_-]{6,64}$/.test(code)) { showMsg('同步码格式不正确'); return; }
            syncId.value = code;
            localStorage.setItem('otc_uid', code);
            syncCodeInput.value = '';
            await loadFromCloud(code);
            showMsg('已切换同步码，数据已加载');
        };
        const copySyncCode = () => {
            navigator.clipboard?.writeText(syncId.value).then(() => showMsg('同步码已复制'));
        };
        const addToHistory = song => {
            const idx = history.value.findIndex(s => s.id === song.id);
            if (idx > -1) history.value.splice(idx, 1);
            history.value.unshift({ ...song, playedAt: Date.now() });
            if (history.value.length > 100) history.value.length = 100;
        };
        const clearHistory = () => {
            if (!confirm('确定清空播放历史吗？')) return;
            history.value = [];
        };
        watch(favorites, v => { localStorage.setItem('otc_favs', JSON.stringify(v)); scheduleSave(); }, { deep: true });
        watch(playlists, v => { localStorage.setItem('otc_pls',  JSON.stringify(v)); scheduleSave(); }, { deep: true });
        watch(history,   v => { localStorage.setItem('otc_history', JSON.stringify(v)); scheduleSave(); }, { deep: true });
        loadFromCloud(syncId.value);
        const displaySongs = computed(() => {
            if (currentTab.value === 'search')    return songs.value;
            if (currentTab.value === 'favorites') return favorites.value;
            if (currentTab.value === 'history')   return history.value;
            if (currentTab.value === 'playlists') return currentPlaylist.value ? currentPlaylist.value.songs : [];
            return [];
        });
        const hasPrev = computed(() => playQueue.value.length > 0 && currentQueueIndex.value > 0);
        const hasNext = computed(() => playQueue.value.length > 0 && currentQueueIndex.value < playQueue.value.length - 1);
        const showMsg = msg => { message.value = msg; setTimeout(() => message.value = '', 2200); };
        const fmt = s => {
            if (isNaN(s) || s == null) return '00:00';
            return \`\${Math.floor(s/60).toString().padStart(2,'0')}:\${Math.floor(s%60).toString().padStart(2,'0')}\`;
        };
        const searchMusic = async () => {
            if (!keyword.value.trim()) return;
            loading.value = true;
            try {
                const body = {
                    req_1: {
                        method: 'DoSearchForQQMusicDesktop',
                        module: 'music.search.SearchCgiService',
                        param: { num_per_page: 25, page_num: 1, query: keyword.value, search_type: 0 },
                    },
                };
                const res = await axios.post(PROXY + 'https://u.y.qq.com/cgi-bin/musicu.fcg', body);
                const list = res.data?.req_1?.data?.body?.song?.list || [];
                songs.value = list.map(item => ({
                    id:      item.id || item.songid,
                    songmid: item.mid || item.songmid,
                    title:   item.title || item.songname,
                    artist:  item.singer?.map(s => s.name).join(', ') || '未知歌手',
                    artwork: item.album?.mid
                        ? \`https://y.gtimg.cn/music/photo_new/T002R800x800M000\${item.album.mid}.jpg\`
                        : defaultCover,
                    duration: item.interval ? fmt(item.interval) : '03:30',
                }));
                showMsg(\`找到 \${songs.value.length} 首歌曲\`);
            } catch { showMsg('搜索失败'); }
            finally { loading.value = false; }
        };
        const switchTab = tab => {
            currentTab.value = tab;
            if (tab !== 'playlists') currentPlaylist.value = null;
        };
        const playSong = async (song, queue, queueIndex) => {
            if (queue !== undefined) {
                playQueue.value = queue;
                currentQueueIndex.value = queueIndex;
            } else {
                const list = displaySongs.value;
                const idx  = list.findIndex(s => s.id === song.id);
                playQueue.value = [...list];
                currentQueueIndex.value = idx >= 0 ? idx : 0;
            }
            currentSong.value = song;
            lyrics.value = [];
            currentLyricIdx.value = -1;
            showMsg('获取播放链接...');
            registerMediaSessionHandlers();
            pushMediaSession([]);
            try {
                const levelMap = { low: 'standard', standard: 'exhigh', high: 'lossless' };
                const url = \`\${MUSIC_API_BASE}/music/qq_song_kw.php?id=\${song.songmid}&level=\${levelMap[currentQuality.value]}&type=json\`;
                const res = await axios.get(PROXY + url);
                if (res.data?.data?.url) {
                    currentPlayUrl.value = res.data.data.url;
                    isPlaying.value = true;
                    if (MS) MS.playbackState = 'playing';
                    setTimeout(() => audioPlayer.value?.play(), 100);
                    fetchLyrics();
                    addToHistory(song);
                    desktopPage.value = 'player';
                } else { showMsg('链接获取失败'); }
            } catch { showMsg('播放失败'); }
        };
        const playAll     = list => { if (!list?.length) return; isShuffle.value = false; const q = [...list]; playSong(q[0], q, 0); showMsg(\`开始播放 \${q.length} 首\`); };
        const playShuffle = list => { if (!list?.length) return; isShuffle.value = true;  const q = [...list].sort(() => Math.random()-0.5); playSong(q[0], q, 0); showMsg(\`随机播放 \${q.length} 首\`); };
        const refreshPlay = () => playSong(currentSong.value);
        const isFavorite     = song => favorites.value.some(f => f.id === song.id);
        const toggleFavorite = song => {
            const idx = favorites.value.findIndex(f => f.id === song.id);
            if (idx > -1) { favorites.value.splice(idx, 1); showMsg('已取消收藏'); }
            else          { favorites.value.push(song);     showMsg('已添加到收藏'); }
        };
        const createPlaylist = () => {
            if (!newPlaylistName.value.trim()) return;
            playlists.value.push({ name: newPlaylistName.value.trim(), songs: [] });
            newPlaylistName.value = ''; showCreatePlaylist.value = false; showMsg('列表已创建');
        };
        const deletePlaylist = idx => {
            if (!confirm('确定删除该列表吗？')) return;
            if (currentPlaylist.value === playlists.value[idx]) currentPlaylist.value = null;
            playlists.value.splice(idx, 1);
        };
        const openPlaylist      = pl   => { currentPlaylist.value = pl; };
        const showAddToPlaylist = song => { songToPlaylist.value = song; };
        const addToPlaylist = pl => {
            if (pl.songs.some(s => s.id === songToPlaylist.value.id)) { showMsg('歌曲已在列表中'); }
            else { pl.songs.push(songToPlaylist.value); showMsg(\`已添加到《\${pl.name}》\`); }
            songToPlaylist.value = null;
        };
        const removeFromPlaylist = song => {
            if (!currentPlaylist.value) return;
            const idx = currentPlaylist.value.songs.findIndex(s => s.id === song.id);
            if (idx < 0) return;
            currentPlaylist.value.songs.splice(idx, 1);
            const qi = playQueue.value.findIndex(s => s.id === song.id);
            if (qi > -1) { playQueue.value.splice(qi, 1); if (currentQueueIndex.value >= qi) currentQueueIndex.value = Math.max(0, currentQueueIndex.value-1); }
        };
        const scrollLyricsToActive = () => {
            nextTick(() => {
                const container = lyricsContainerSidebar.value;
                if (!container) return;
                const active = container.querySelector('.lyric-line-active');
                if (active) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
        };
        const onLoaded = () => {
            duration.value = fmt(audioPlayer.value.duration);
            msSetPositionState(audioPlayer.value);
        };
        const onTimeUpdate = () => {
            if (!audioPlayer.value) return;
            currentTime.value     = fmt(audioPlayer.value.currentTime);
            progressPercent.value = (audioPlayer.value.currentTime / audioPlayer.value.duration * 100) || 0;
            const nowSec = Math.floor(audioPlayer.value.currentTime);
            if (nowSec !== onTimeUpdate._lastSec) {
                onTimeUpdate._lastSec = nowSec;
                msSetPositionState(audioPlayer.value);
            }
            if (lyrics.value.length) {
                const t = audioPlayer.value.currentTime;
                let idx = -1;
                for (let i = 0; i < lyrics.value.length; i++) {
                    if (lyrics.value[i].time <= t) idx = i; else break;
                }
                if (idx !== currentLyricIdx.value) {
                    currentLyricIdx.value = idx;
                    if (showLyrics.value) scrollLyricsToActive();
                }
            }
        };
        onTimeUpdate._lastSec = -1;
        const togglePlay = () => {
            if (!audioPlayer.value) return;
            if (isPlaying.value) {
                audioPlayer.value.pause();
                if (MS) MS.playbackState = 'paused';
            } else {
                audioPlayer.value.play();
                if (MS) MS.playbackState = 'playing';
            }
            isPlaying.value = !isPlaying.value;
        };
        const toggleLoop    = () => { isLoop.value    = !isLoop.value;    showMsg(isLoop.value    ? '单曲循环 开' : '单曲循环 关'); };
        const toggleShuffle = () => { isShuffle.value = !isShuffle.value; showMsg(isShuffle.value ? '随机播放 开' : '随机播放 关'); };
        const seekByFraction = frac => {
            if (!audioPlayer.value?.duration) return;
            audioPlayer.value.currentTime = frac * audioPlayer.value.duration;
            msSetPositionState(audioPlayer.value);
        };
        const seek = e => {
            const rect = e.currentTarget.getBoundingClientRect();
            seekByFraction((e.clientX - rect.left) / rect.width);
        };
        const seekFromTabletBar = e => {
            const rect = e.currentTarget.getBoundingClientRect();
            seekByFraction((e.clientX - rect.left) / rect.width);
        };
        const onEnded = () => {
            isPlaying.value = false;
            if (MS) MS.playbackState = 'none';
            if (isLoop.value) { audioPlayer.value.currentTime = 0; audioPlayer.value.play(); isPlaying.value = true; if (MS) MS.playbackState = 'playing'; return; }
            playNext();
        };
        const pickRandom = () => {
            const idx = Math.floor(Math.random() * playQueue.value.length);
            playSong(playQueue.value[idx], playQueue.value, idx);
        };
        const playPrev = () => {
            if (!playQueue.value.length) return;
            if (isShuffle.value) { pickRandom(); return; }
            if (currentQueueIndex.value > 0) { const ni = currentQueueIndex.value-1; playSong(playQueue.value[ni], playQueue.value, ni); }
        };
        const playNext = () => {
            if (!playQueue.value.length) return;
            if (isShuffle.value) { pickRandom(); return; }
            if (currentQueueIndex.value < playQueue.value.length-1) { const ni = currentQueueIndex.value+1; playSong(playQueue.value[ni], playQueue.value, ni); }
        };
        const downloadSong = () => {
            if (!currentPlayUrl.value) return;
            downloading.value = true;
            try {
                const ext = currentPlayUrl.value.includes('.flac') ? 'flac'
                          : currentPlayUrl.value.includes('.m4a')  ? 'm4a'
                          : 'mp3';
                const filename = \`\${currentSong.value.title} - \${currentSong.value.artist}.\${ext}\`;
                const a = document.createElement('a');
                a.href = PROXY + currentPlayUrl.value;
                a.download = filename;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                showMsg('下载已开始，请查看浏览器下载列表');
            } catch { showMsg('下载失败'); }
            finally { setTimeout(() => { downloading.value = false; }, 2000); }
        };
        return {
            currentTab, keyword, songs, loading, currentSong, currentPlayUrl, message, downloading,
            currentQuality, qualities, quickTags, audioPlayer, isPlaying, isLoop, isShuffle,
            currentTime, duration, progressPercent, playQueue, currentQueueIndex,
            favorites, playlists, currentPlaylist, showCreatePlaylist, newPlaylistName, songToPlaylist,
            showLyrics, lyrics, currentLyricIdx, loadingLyrics, lyricsError, mediaSessionActive,
            lyricsContainerSidebar,
            history, showSyncModal, syncCodeInput, syncStatus, syncId,
            clearHistory, switchSyncCode, copySyncCode,
            desktopPage, backToList,
            displaySongs, hasPrev, hasNext,
            switchTab, searchMusic, playSong, playAll, playShuffle, refreshPlay,
            toggleFavorite, isFavorite, createPlaylist, deletePlaylist,
            openPlaylist, showAddToPlaylist, addToPlaylist, removeFromPlaylist,
            onLoaded, onTimeUpdate, togglePlay, toggleLoop, toggleShuffle,
            seek, seekFromTabletBar, onEnded, playPrev, playNext, downloadSong, toggleLyrics,
        };
    }
}).mount('#app');
<\/script>
</body>
</html>`;
}