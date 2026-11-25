#!/usr/bin/env python3
"""
hermes_bridge.py — 把官方 Hermes Agent 暴露为 OpenAI 兼容的 HTTP 端点，供 Node 8777 桥接层调用。

运行位置：WSL2（Hermes Agent 已在其中安装，用 DeepSeek 作为底层模型）。
原理：收到 POST /v1/chat/completions → 把 messages 拼成一段 prompt → 调用 `hermes chat -q "<prompt>"`
      → 把 Hermes 的 stdout 作为 assistant 回复，包装成 OpenAI 格式返回。

为什么这样：Hermes 本身是 CLI / 消息网关形态，没有内置 HTTP chat API；用 `-q` 一次性查询模式
           最稳，且能利用 Hermes 的持久记忆、技能、MCP 工具与用户画像。

依赖：仅 Python 标准库（WSL2 自带），无需额外 pip 包。
启动：python3 hermes_bridge.py --port 8765
"""

import argparse, json, subprocess, sys, os, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 默认用已验证的绝对路径，避免 systemd/nohup 环境 PATH 缺少 ~/.local/bin
_DEFAULT_HERMES = "/home/freddy19871122/.hermes/hermes-agent/.hermes/bin/hermes"
if not os.path.isfile(_DEFAULT_HERMES):
    _DEFAULT_HERMES = os.path.expanduser("~/.local/bin/hermes")
if not os.path.isfile(_DEFAULT_HERMES):
    _DEFAULT_HERMES = "hermes"
HERMES_BIN = os.environ.get("HERMES_BIN", _DEFAULT_HERMES)
CALL_TIMEOUT = int(os.environ.get("HERMES_TIMEOUT", "120"))
KEEP_SESSION = os.environ.get("HERMES_KEEP_SESSION", "0") == "1"  # 预留：将来可改 --continue

# 给 Hermes 的系统纪律（与 Node 侧 hermes.js 的 BASE_SYSTEM 对齐，双保险）
GUARDRAIL = (
    "你是全球市场监测系统的核心智能体，底层用 DeepSeek。纪律："
    "只依据给定数据与事实回答，缺数据就直说，禁止编造数字；"
    "禁止给出买入/卖出/加仓/减仓/建仓/清仓/抄底/止盈/止损/满仓/梭哈等买卖建议；"
    "不预测点位与涨跌概率；结论要标注来源与可证伪条件；回答简洁结构化。"
)

def messages_to_prompt(messages):
    parts = []
    for m in messages:
        role = m.get("role", "user")
        content = m.get("content", "")
        if role == "system":
            parts.append("【系统指令】\n" + content)
        elif role == "assistant":
            parts.append("【此前回答】\n" + content)
        else:
            parts.append("【用户问题】\n" + content)
    parts.append("【请回答 above 的用户问题，遵守系统指令】")
    return "\n\n".join(parts)

def call_hermes(prompt):
    """用 --query-file - 从 stdin 传入，避免任何 shell 转义问题（原文 verbatim）。
    兼容多种 hermes 版本的 CLI 形态：先试 chat --query-file -，失败再试 -q。"""
    import re
    # 已验证：--query-file - + --oneshot -Q 在非 TTY 下一次回答即退出
    candidates = [
        [HERMES_BIN, "chat", "--query-file", "-", "--oneshot", "-Q", "--no-restore-cwd"],
        [HERMES_BIN, "chat", "--query-file", "-", "--oneshot", "-Q"],
        [HERMES_BIN, "chat", "--query-file", "-"],
    ]
    last_err = ""
    for cmd in candidates:
        try:
            proc = subprocess.run(
                cmd,
                input=prompt.encode("utf-8"),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=CALL_TIMEOUT,
            )
        except FileNotFoundError:
            raise RuntimeError("找不到 hermes 可执行文件：%s" % HERMES_BIN)
        out = re.sub(r"\x1b\[[0-9;]*m", "", proc.stdout.decode("utf-8", "replace")).strip()
        err = proc.stderr.decode("utf-8", "replace").strip()
        # 去掉 Hermes -Q 输出末尾的 session_id 行与空行，只保留回答正文
        out = re.sub(r"\n\nsession_id:\s*\S+\s*$", "", out).strip()
        if proc.returncode == 0 and out:
            return out
        last_err = "退出码 %d: %s" % (proc.returncode, (err or out)[:300])
    raise RuntimeError("hermes 各调用形式均失败，最后错误：" + last_err)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[bridge] " + (fmt % args) + "\n")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/health"):
            return self._json(200, {"ok": True, "service": "hermes-bridge", "hermes": HERMES_BIN})
        return self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") not in ("/v1/chat/completions", "/chat/completions"):
            return self._json(404, {"ok": False, "error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            messages = data.get("messages") or []
            if not messages:
                return self._json(400, {"ok": False, "error": "empty messages"})
            # 注入纪律作为首条 system（若调用方已带 system 则合并）
            sys_msg = {"role": "system", "content": GUARDRAIL}
            if messages[0].get("role") == "system":
                sys_msg["content"] = messages[0]["content"] + "\n\n" + GUARDRAIL
                messages = [sys_msg] + messages[1:]
            else:
                messages = [sys_msg] + messages
            prompt = messages_to_prompt(messages)
            t0 = time.time()
            text = call_hermes(prompt)
            return self._json(200, {
                "id": "chatcmpl-hermes-" + str(int(time.time())),
                "object": "chat.completion",
                "created": int(time.time()),
                "model": data.get("model") or "hermes",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
                          "elapsed_ms": int((time.time() - t0) * 1000)},
            })
        except subprocess.TimeoutExpired:
            return self._json(504, {"ok": False, "error": "hermes 调用超时"})
        except Exception as e:
            return self._json(500, {"ok": False, "error": str(e)})

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    # WSL2 里必须绑 0.0.0.0，否则 Windows 侧 127.0.0.1:port 访问不到
    ap.add_argument("--host", default=os.environ.get("HERMES_BRIDGE_HOST", "0.0.0.0"))
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print("Hermes bridge listening on http://%s:%d/v1/chat/completions" % (args.host, args.port))
    print("Hermes binary: %s (change with HERMES_BIN env)" % HERMES_BIN)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("stopped")
        srv.shutdown()

if __name__ == "__main__":
    main()
