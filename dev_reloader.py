#!/usr/bin/env python3
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent
WATCH_SUFFIXES = {".py", ".html", ".css", ".js", ".sh"}
IGNORED_DIRS = {".git", "__pycache__", ".pytest_cache"}


def watched_files():
    for path in ROOT.rglob("*"):
        if any(part in IGNORED_DIRS for part in path.parts):
            continue
        if path.is_file() and path.suffix in WATCH_SUFFIXES:
            yield path


def snapshot():
    state = {}
    for path in watched_files():
        try:
            state[str(path)] = path.stat().st_mtime_ns
        except FileNotFoundError:
            continue
    return state


def start_server():
    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["METRIC_FUND_RELOADER_CHILD"] = "1"
    return subprocess.Popen([sys.executable, "-B", "server.py"], cwd=ROOT, env=env)


def stop_server(process):
    if process.poll() is not None:
        return
    process.send_signal(signal.SIGINT)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)


def main():
    interval = float(os.environ.get("RELOAD_INTERVAL", "0.7"))
    process = start_server()
    last = snapshot()
    print("Auto-reloader watching server.py and public assets.")
    try:
        while True:
            time.sleep(interval)
            current = snapshot()
            if current != last:
                print("Change detected; restarting server...")
                stop_server(process)
                process = start_server()
                last = current
            elif process.poll() is not None:
                print(f"Server exited with code {process.returncode}; restarting...")
                process = start_server()
                last = snapshot()
    except KeyboardInterrupt:
        stop_server(process)


if __name__ == "__main__":
    main()
