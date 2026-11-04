
// mellow watch & learn — Node.js 18+
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SUPADATA_API_KEY = process.env.SUPADATA_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const ROOT = __dirname;

const cache = new Map();
const CACHE_TIME = 6 * 60 * 60 * 1000;
const requestCounts = new Map();
const DAILY_LIMIT = 5;

function send(res, status, data) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function getVideoId(value) {
  const url = new URL(value);
  const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');

  if (host === 'youtu.be') {
    return url.pathname.split('/').filter(Boolean)[0] || null;
  }

  if (host === 'youtube.com') {
    return url.searchParams.get('v') ||
      (url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/) || [])[1] || null;
  }

  return null;
}


async function errorMessage(response) {
  const text = await response.text();

  try {
    const data = JSON.parse(text);

    if (typeof data.details === 'string') return data.details;
    if (typeof data.message === 'string') return data.message;

    if (data.error && typeof data.error === 'object') {
      return data.error.message ||
        data.error.status ||
        JSON.stringify(data.error);
    }

    if (typeof data.error === 'string') return data.error;

    return text || `API 오류 ${response.status}`;
  } catch {
    return text || `API 오류 ${response.status}`;
  }
}


async function getTranscript(videoUrl) {
  const endpoint = new URL('https://api.supadata.ai/v1/transcript');
  endpoint.searchParams.set('url', videoUrl);
  endpoint.searchParams.set('lang', 'en');
  endpoint.searchParams.set('mode', 'auto');

  let response = await fetch(endpoint, {
    headers: { 'x-api-key': SUPADATA_API_KEY }
  });

  if (!response.ok) {
    throw new Error('영어 자막을 가져오지 못했어요: ' + await errorMessage(response));
  }

  let data = await response.json();

  if (data.jobId) {
    let completed = false;

    for (let i = 0; i < 45; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000));

      response = await fetch(
        'https://api.supadata.ai/v1/transcript/' + encodeURIComponent(data.jobId),
        { headers: { 'x-api-key': SUPADATA_API_KEY } }
      );

      if (!response.ok) {
        throw new Error('자막 작업 확인 실패: ' + await errorMessage(response));
      }

      const job = await response.json();

      if (job.status === 'completed') {
        data = job.result || job;
        completed = true;
        break;
      }

      if (job.status === 'failed') {
        throw new Error(job.error || '자막 생성에 실패했어요.');
      }
    }

    if (!completed) {
      throw new Error('자막 생성 시간이 초과됐어요. 잠시 후 다시 시도해 주세요.');
    }
  }

  return data;
}

function normalize(data) {
  if (!Array.isArray(data.content)) return [];

  return data.content.map(item => {
    const start = Number(item.offset || 0) / 1000;
    const duration = Number(item.duration || 2500) / 1000;

    return {
      start,
      end: start + duration,
      en: String(item.text || '').trim()
    };
  }).filter(item => item.en);
}

async function translateBatch(segments) {
  const endpoint =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(GEMINI_MODEL) +
    ':generateContent?key=' + encodeURIComponent(GEMINI_API_KEY);

  const input = segments.map((item, index) => ({
    id: index,
    text: item.en
  }));

  const prompt =
    'Translate each English subtitle into natural Korean. ' +
    'Keep every item and its order. Return only a JSON array. ' +
    'Each object must contain id and ko fields.\n\n' +
    JSON.stringify(input);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json'
      }
    })
  });

  if (!response.ok) {
    const message = await errorMessage(response);

    if (response.status === 429) {
      throw new Error('Gemini 무료 사용량 한도에 도달했어요. 나중에 다시 시도해 주세요.');
    }

    throw new Error('Gemini 번역 오류: ' + message);
  }

  const data = await response.json();
  const resultText = data.candidates?.[0]?.content?.parts
    ?.map(part => part.text || '').join('');

  if (!resultText) {
    throw new Error('Gemini 번역 결과가 비어 있어요.');
  }

  let result;

  try {
    result = JSON.parse(resultText);
  } catch {
    throw new Error('번역 결과를 읽을 수 없어요.');
  }

  if (!Array.isArray(result)) {
    throw new Error('번역 결과 형식이 올바르지 않아요.');
  }

  const translations = new Map(
    result.map(item => [Number(item.id), String(item.ko || '')])
  );

  return segments.map((item, index) => ({
    ...item,
    ko: translations.get(index) || ''
  }));
}

async function translateAll(segments) {
  const output = [];
  const batchSize = 25;

  for (let i = 0; i < segments.length; i += batchSize) {
    const batch = segments.slice(i, i + batchSize);
    const translated = await translateBatch(batch);
    output.push(...translated);
  }

  return output;
}

function canRequest(ip) {
  const today = new Date().toISOString().slice(0, 10);
  const old = requestCounts.get(ip);

  if (!old || old.day !== today) {
    requestCounts.set(ip, { day: today, count: 1 });
    return true;
  }

  if (old.count >= DAILY_LIMIT) return false;

  old.count++;
  return true;
}

async function handleTranscript(req, res, requestUrl) {
  if (!SUPADATA_API_KEY || !GEMINI_API_KEY) {
    return send(res, 503, {
      error: 'Render 환경 변수 SUPADATA_API_KEY와 GEMINI_API_KEY를 확인해 주세요.'
    });
  }

  const videoUrl = requestUrl.searchParams.get('url');

  if (!videoUrl) {
    return send(res, 400, { error: '유튜브 링크를 입력해 주세요.' });
  }

  let videoId;

  try {
    videoId = getVideoId(videoUrl);
  } catch {
    return send(res, 400, { error: '올바른 유튜브 링크를 입력해 주세요.' });
  }

  if (!videoId) {
    return send(res, 400, { error: '지원하지 않는 유튜브 링크예요.' });
  }

  const saved = cache.get(videoId);

  if (saved && Date.now() - saved.time < CACHE_TIME) {
    return send(res, 200, saved.data);
  }

  const ip = String(
    req.headers['x-forwarded-for'] ||
    req.socket.remoteAddress ||
    'unknown'
  ).split(',')[0].trim();

  if (!canRequest(ip)) {
    return send(res, 429, {
      error: '오늘 신규 자막 요청 5회를 모두 사용했어요. 내일 다시 시도해 주세요.'
    });
  }

  try {
    const transcript = await getTranscript(videoUrl);
    const english = normalize(transcript);

    if (!english.length) {
      throw new Error('영어 자막을 찾지 못했어요. 이 영상은 자막 생성이 지원되지 않을 수 있어요.');
    }

    const segments = await translateAll(english);

    const result = {
      segments,
      languages: {
        english: transcript.lang || 'en',
        korean: 'Gemini 번역'
      },
      warning: null
    };

    cache.set(videoId, { time: Date.now(), data: result });

    return send(res, 200, result);
  } catch (error) {
    console.error(error);
    return send(res, 502, {
      error: error.message || '자막을 불러오지 못했어요.'
    });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  let url;

  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }

  if (url.pathname === '/api/transcript' && req.method === 'GET') {
    return handleTranscript(req, res, url);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end('Method not allowed');
  }

  let pathname;

  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }

  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.resolve(ROOT, requested);

  if (!full.startsWith(ROOT + path.sep) ||
      !fs.existsSync(full) ||
      fs.statSync(full).isDirectory()) {
    res.writeHead(404);
    return res.end('Not found');
  }

  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon'
  };

  const ext = path.extname(full).toLowerCase();

  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream'
  });

  if (req.method === 'HEAD') return res.end();

  fs.createReadStream(full).pipe(res);
});

server.listen(PORT, () => {
  console.log(`mellow running on port ${PORT}`);
});
