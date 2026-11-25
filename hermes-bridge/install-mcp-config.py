#!/usr/bin/env python3
# 把 market_modules MCP 服务注册到 Hermes config.yaml（幂等，自动备份）
import os
import re
import shutil
import datetime

path = os.path.expanduser('~/.hermes/config.yaml')
script = '/mnt/d/WorkBuddy/projects/GlobalMarketMonitor/hermes-bridge/mcp-market-modules.js'

with open(path, 'r', encoding='utf-8') as f:
    text = f.read()

entry = (
    '  market_modules:\n'
    '    command: "node"\n'
    '    args: ["' + script + '"]\n'
    '    timeout: 30\n'
    '    connect_timeout: 30\n'
)

m = re.search(r'^mcp_servers\s*:\s*$', text, re.M)
if m and 'market_modules:' in text:
    print('SKIP: market_modules already registered')
else:
    backup = path + '.bak-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    shutil.copy2(path, backup)
    if m:
        # 插入到 mcp_servers 块的首个子项之前
        head = text[:m.end()]
        tail = text[m.end():]
        text = head + '\n' + entry + tail.lstrip('\n')
    else:
        text = text.rstrip('\n') + '\n\n# Added by GlobalMarketMonitor P3: module perception MCP\nmcp_servers:\n' + entry
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    print('OK: registered market_modules, backup=' + backup)

print(open(path, encoding='utf-8').read()[-420:])
