// mellow local backend — Node.js 18+
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SUPADATA_API_KEY;
const ROOT = __dirname;

async function transcript(url, lang) {
  const endpoint = new URL('https://api.supadata.ai/v1/transcript');
  endpoint.searchParams.set('url', url);
  endpoint.searchParams.set('lang', lang);
  endpoint.searchParams.set('mode', 'auto');
  const response = await fetch(endpoint, { headers: { 'x-api-key': API_KEY } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.details || data.message || data.error || `Transcript API error ${response.status}`);
  if (data.jobId) {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const poll = await fetch(`https://api.supadata.ai/v1/transcript/${encodeURIComponent(data.jobId)}`, {
        headers: { 'x-api-key': API_KEY }
      });
      const job = await poll.json();
      if (job.status === 'completed') return job.result || job;
      if (job.status === 'failed') throw new Error(job.error || 'Transcript processing failed');
    }
    throw new Error('자막 생성 시간이 초과됐어요. 잠시 후 다시 시도해 주세요.');
  }
  return data;
}
function normalize(payload) {
  if (!Array.isArray(payload.content)) return [];
  return payload.content.map(x => ({
    start: Number(x.offset || 0) / 1000,
    end: (Number(x.offset || 0) + Number(x.duration || 2500)) / 1000,
    text: String(x.text || '')
  }));
}
function align(en, ko) {
  return en.map((a, i) => {
    let best = null, delta = Infinity;
    for (const b of ko) {
      const d = Math.abs(b.start - a.start);
      if (d < delta) { delta = d; best = b; }
    }
    return { start: a.start, end: a.end, en: a.text, ko: best && delta <= 5 ? best.text : '' };
  });
}
http.createServer(async (req, res) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8' };
  if (req.url.startsWith('/api/transcript')) {
    if (!API_KEY) { res.writeHead(503, headers); return res.end(JSON.stringify({error:'서버에 SUPADATA_API_KEY가 설정되지 않았어요. README 안내를 확인해 주세요.'})); }
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const videoUrl = u.searchParams.get('url');
      if (!videoUrl || !/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(videoUrl)) throw new Error('올바른 유튜브 링크를 입력해 주세요.');
      const [enData, koData] = await Promise.all([transcript(videoUrl, 'en'), transcript(videoUrl, 'ko')]);
      const en = normalize(enData), ko = normalize(koData);
      if (!en.length) throw new Error('영어 자막을 찾을 수 없어요.');
      const segments = align(en, ko);
      res.writeHead(200, headers);
      res.end(JSON.stringify({segments, languages:{english:enData.lang||'unknown',korean:koData.lang||'unknown'}, warning:koData.lang !== 'ko' ? '한국어 자막이 제공되지 않아 번역 언어가 다를 수 있습니다.' : null}));
    } catch (e) {
      res.writeHead(502, headers);
      res.end(JSON.stringify({error:e.message || '자막을 불러오지 못했어요.'}));
    }
    return;
  }
  const pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  const type = full.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
  res.writeHead(200, {'Content-Type':type});
  fs.createReadStream(full).pipe(res);
}).listen(PORT, () => console.log(`mellow running at http://localhost:${PORT}`));
