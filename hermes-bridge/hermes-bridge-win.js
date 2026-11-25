'use strict';
/**
 * hermes-bridge-win.js — Windows 侧 Hermes 桥接（无需防火墙改动的修复方案）
 *
 * 背景：
 *   WSL2 内 hermes_bridge.py 监听 0.0.0.0:8765，但 Windows 11 的
 *   Hyper-V 防火墙默认入站动作为 Block，且当前用户非管理员，无法新增放行规则，
 *   导致 Windows 侧访问 127.0.0.1:8765 与 WSL IP:8765 均超时。
 *
 * 方案：
 *   在 Windows 侧监听 127.0.0.1:8765，收到 OpenAI 兼容请求后，
 *   用 wsl.exe 调用 WSL 内官方 Hermes CLI（UTF-8 文件传 prompt），
 *   把 stdout 包装回 OpenAI 格式。Hermes 的持久记忆 / 技能 / MCP 仍在 WSL 内执行。
 *
 * 与 hermes.js 的约定完全一致：GET /health、POST /v1/chat/completions。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.HERMES_WIN_BRIDGE_PORT || 8765);
const HOST = '127.0.0.1';
const DISTRO = process.env.HERMES_WSL_DISTRO || 'Ubuntu';
const HERMES_BIN = process.env.HERMES_BIN ||
  '/home/freddy19871122/.hermes/hermes-agent/.hermes/bin/hermes';
const TIMEOUT_MS = Number(process.env.HERMES_TIMEOUT_MS || 120000);
// P3：预加载模块感知技能；可用 HERMES_SKILLS= 覆盖（留空则禁用）
const SKILLS = process.env.HERMES_SKILLS === undefined ? 'market-modules' : String(process.env.HERMES_SKILLS).trim();
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TMP_DIR = path.join(PROJECT_ROOT, 'data', 'hermes-bridge');
fs.mkdirSync(TMP_DIR, { recursive: true });

const GUARDRAIL = [
  '你是全球市场监测系统的核心智能体 Hermes，底层用 DeepSeek。纪律：',
  '只依据给定数据与事实回答，缺数据就直说，禁止编造数字；',
  '禁止给出买入/卖出/加仓/减仓/建仓/清仓/抄底/止盈/止损/满仓/梭哈等买卖建议；',
  '不预测点位与涨跌概率；结论要标注来源与可证伪条件；回答简洁结构化。'
].join('');

function toWslPath(winPath) {
  const p = path.resolve(winPath).replace(/\\/g, '/');
  const m = /^([A-Za-z]):\/(.*)$/.exec(p);
  return m ? '/mnt/' + m[1].toLowerCase() + '/' + m[2] : p;
}

function messagesToPrompt(messages) {
  const parts = [];
  for (const m of messages || []) {
    const role = m && m.role === 'assistant' ? 'assistant' : (m && m.role === 'system' ? 'system' : 'user');
    const content = String((m && m.content) || '');
    if (role === 'system') parts.push('【系统指令】\n' + content);
    else if (role === 'assistant') parts.push('【此前回答】\n' + content);
    else parts.push('【用户问题】\n' + content);
  }
  parts.push('【请回答 above 的用户问题，遵守系统指令】');
  return parts.join('\n\n');
}

function cleanOutput(buf) {
  let s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  // 去掉 ANSI 转义色码
  s = s.replace(/\x1b\[[0-9;]*m/g, '');
  // 去掉 Hermes -Q 末尾的 session_id 行
  s = s.replace(/\n\nsession_id:\s*\S+\s*$/i, '').replace(/\nsession_id:\s*\S+\s*$/i, '');
  // 去掉可能混入的 CLI 提示行（不影响正文）
  s = s.split('\n').filter(line => !/^Hermes (bridge|CLI)/i.test(line)).join('\n');
  return s.trim();
}

function callHermes(prompt) {
  return new Promise((resolve) => {
    const file = path.join(TMP_DIR, 'prompt-' + process.pid + '-' + Date.now() + '-' +
      Math.random().toString(36).slice(2, 8) + '.txt');
    fs.writeFileSync(file, prompt, { encoding: 'utf8' }); // 无 BOM
    const args = [
      '-d', DISTRO, '--exec', HERMES_BIN,
      'chat', '--query-file', toWslPath(file),
      '--oneshot', '-Q', '--no-restore-cwd'
    ];
    if (SKILLS) args.push('-s', SKILLS);
    const child = spawn('wsl.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = [], err = [], done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch (_) {}
      try { fs.unlinkSync(file); } catch (_) {}
      resolve({ ok: false, error: 'Hermes 调用超时(' + TIMEOUT_MS + 'ms)' });
    }, TIMEOUT_MS);

    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', e => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { fs.unlinkSync(file); } catch (_) {}
      resolve({ ok: false, error: 'wsl.exe 启动失败: ' + e.message });
    });
    child.on('close', code => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { fs.unlinkSync(file); } catch (_) {}
      const text = cleanOutput(Buffer.concat(out));
      const stderrText = cleanOutput(Buffer.concat(err));
      if (code === 0 && text) return resolve({ ok: true, text });
      resolve({ ok: false, error: 'Hermes 退出码 ' + code + ': ' + (stderrText || text || '').slice(0, 300) });
    });
  });
}

// 串行队列：避免多个模块同时触发 Hermes CLI 造成 session / 资源竞争
let queue = Promise.resolve();
function enqueue(task) {
  const next = queue.then(task, task);
  queue = next.catch(() => {});
  return next;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
  if (req.method === 'GET' && (url === '/health' || url === '/')) {
    return sendJson(res, 200, {
      ok: true, service: 'hermes-bridge-win', mode: 'windows-shim-to-wsl-cli',
      hermes: HERMES_BIN, distro: DISTRO, port: PORT, skills: SKILLS || null
    });
  }
  if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
    try {
      const data = await readBody(req);
      const messages = Array.isArray(data.messages) ? data.messages : [];
      if (!messages.length) return sendJson(res, 400, { ok: false, error: 'empty messages' });
      let sys = { role: 'system', content: GUARDRAIL };
      if (messages[0] && messages[0].role === 'system') {
        sys.content = String(messages[0].content || '') + '\n\n' + GUARDRAIL;
        messages[0] = sys;
      } else {
        messages.unshift(sys);
      }
      const prompt = messagesToPrompt(messages);
      const t0 = Date.now();
      const r = await enqueue(() => callHermes(prompt));
      if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error });
      return sendJson(res, 200, {
        id: 'chatcmpl-hermes-win-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: data.model || 'hermes',
        choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, elapsed_ms: Date.now() - t0 }
      });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message || String(e) });
    }
  }
  return sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log('[hermes-bridge-win] listening on http://' + HOST + ':' + PORT + '/v1/chat/completions');
  console.log('[hermes-bridge-win] -> wsl.exe -d ' + DISTRO + ' --exec ' + HERMES_BIN);
});
server.on('error', e => {
  console.error('[hermes-bridge-win] listen error: ' + e.message);
  process.exitCode = 1;
});
