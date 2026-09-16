#!/usr/bin/env python3
"""End-to-end check: does one channel message produce two posts?

Stands up a minimal hub that speaks the agent protocol, runs the real bridge
against the real `claude` CLI, sends one inbound message asking for backgrounded
work, and prints every post frame the bridge sends back with a timestamp.

PASS means two posts arrive from a single inbound: the immediate reply, then
the background findings.
"""
import asyncio
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import websockets

PORT = 8791
CHANNEL = "c-e2e"
TEXT = (
    "Use a background Bash task (run_in_background: true) to run exactly "
    "`sleep 20 && echo THE_SECRET_IS_PINEAPPLE`. Reply immediately with just "
    "'started' and end your turn. When that task finishes, tell me the secret "
    "it printed."
)

posts: list[tuple[float, str]] = []
t0 = time.monotonic()


async def hub(ws):
    print(f"[{time.monotonic() - t0:6.2f}s] bridge connected", flush=True)
    hello = json.loads(await ws.recv())
    agent_id = hello["agents"][0]["id"]
    print(f"[{time.monotonic() - t0:6.2f}s] hello from {agent_id}", flush=True)
    await ws.send(json.dumps({
        "type": "inbound", "agent_id": agent_id, "channel_id": CHANNEL,
        "thread_id": None, "message_id": 1, "text": TEXT,
        "author": {"id": "u1", "name": "tom", "type": "user"},
        "mentioned": True, "any_mention": True,
    }))
    print(f"[{time.monotonic() - t0:6.2f}s] sent inbound", flush=True)
    try:
        await pump(ws)
    except websockets.exceptions.ConnectionClosed:
        pass  # the bridge is torn down at the end of the run; not a failure


async def pump(ws):
    async for raw in ws:
        frame = json.loads(raw)
        kind = frame.get("type")
        if kind == "post":
            elapsed = time.monotonic() - t0
            posts.append((elapsed, frame.get("text", "")))
            print(f"[{elapsed:6.2f}s] >>> POST #{len(posts)}: "
                  f"{frame.get('text', '')[:300]!r}", flush=True)
        elif kind == "progress":
            print(f"[{time.monotonic() - t0:6.2f}s]     progress: "
                  f"{frame.get('text', '')[:80]!r}", flush=True)
        elif kind not in ("typing", "reaction", "usage_update"):
            print(f"[{time.monotonic() - t0:6.2f}s]     {kind}", flush=True)


async def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="agora-e2e-"))
    state = tmp / "state.json"
    # Pre-bind the channel so the bridge does not ask for /use first.
    state.write_text(json.dumps({CHANNEL: {"session_id": None, "cwd": str(tmp)}}))

    async with websockets.serve(hub, "127.0.0.1", PORT):
        proc = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name("bridge.py")),
             "--url", f"ws://127.0.0.1:{PORT}", "--token", "t",
             "--agent-id", "claude-cli", "--agent-name", "Claude",
             "--state-file", str(state), "--env-file", str(tmp / "none.env"),
             "--allowed-roots", str(tmp),
             "--claude-args", "--permission-mode bypassPermissions",
             "--timeout", "180", "--followup-idle-timeout", "120"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        try:
            deadline = time.monotonic() + 220
            while time.monotonic() < deadline and len(posts) < 2:
                await asyncio.sleep(0.5)
                if proc.poll() is not None:
                    print("bridge exited early:", flush=True)
                    print(proc.stdout.read()[-3000:], flush=True)
                    return 1
        finally:
            proc.terminate()
            try:
                proc.wait(10)
            except subprocess.TimeoutExpired:
                proc.kill()

    print("\n=== bridge log (tail) ===", flush=True)
    print((proc.stdout.read() or "")[-2500:], flush=True)
    print("\n=== verdict ===", flush=True)
    for i, (at, text) in enumerate(posts, 1):
        print(f"post {i} at {at:.1f}s: {text[:200]!r}")
    if len(posts) >= 2 and "PINEAPPLE" in posts[1][1].upper():
        print("PASS: one inbound produced two posts, the second carrying the "
              "background result")
        return 0
    print("FAIL: expected two posts with the background secret in the second")
    return 1


sys.exit(asyncio.run(main()))
