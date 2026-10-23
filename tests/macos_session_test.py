#!/usr/bin/env python3
"""Exercise session restore and recently closed tabs in real macOS WKWebViews."""

import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path


if sys.platform != "darwin":
    raise SystemExit("This integration test requires macOS and native WKWebViews.")

ROOT = Path(__file__).resolve().parents[1]
FIRST_URL = "http://127.0.0.1:4179/index.html?session=first"
SECOND_URL = "http://127.0.0.1:4179/index.html?session=second"


def wait_for_server(server, server_log_path):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if server.poll() is not None:
            raise RuntimeError(f"Fixture server exited before becoming ready:\n{server_log_path.read_text()}")
        try:
            with socket.create_connection(("127.0.0.1", 4179), timeout=0.2):
                return
        except OSError:
            time.sleep(0.1)
    raise TimeoutError("Fixture server did not become ready")


def stop_process(process):
    if process is None or process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)


def wait_for_report(process, report_path, app_log, timeout=120):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if report_path.exists():
            return json.loads(report_path.read_text())
        if process.poll() is not None:
            app_log.flush()
            app_log.seek(0)
            raise RuntimeError(f"Tauri app exited early:\n{app_log.read()}")
        time.sleep(0.2)
    app_log.flush()
    app_log.seek(0)
    raise TimeoutError(f"Timed out waiting for app report:\n{app_log.read()}")


def wait_for_page_requests(server_log_path, expected_counts, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        output = server_log_path.read_text()
        if all(output.count(f'GET {url.removeprefix("http://127.0.0.1:4179")} HTTP/1.1') >= count
               for url, count in expected_counts.items()):
            return output
        time.sleep(0.2)
    raise TimeoutError(f"Expected fixture page requests were not observed:\n{server_log_path.read_text()}")


def run_phase(phase, session_path, report_path, app_log, downloads_dir):
    report_path.unlink(missing_ok=True)
    env = os.environ.copy()
    env.update({
        "CI": "true",
        "MY_BROWSER_SESSION_TEST_PHASE": phase,
        "MY_BROWSER_SESSION_TEST_PATH": str(session_path),
        "MY_BROWSER_SESSION_TEST_REPORT": str(report_path),
        "MY_BROWSER_SESSION_TEST_DOWNLOAD_DIR": str(downloads_dir),
    })
    process = subprocess.Popen(
        ["pnpm", "tauri", "dev", "--features", "macos-session-test"],
        cwd=ROOT,
        env=env,
        stdout=app_log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        report = wait_for_report(process, report_path, app_log)
        if not report.get("success"):
            app_log.flush()
            app_log.seek(0)
            raise AssertionError(f"Session {phase} phase failed: {report.get('details')}\n{report}\n{app_log.read()}")
        return report
    finally:
        stop_process(process)


def main():
    with tempfile.TemporaryDirectory(prefix="my-browser-session-test-") as temporary:
        temp_dir = Path(temporary)
        session_path = temp_dir / "session.json"
        report_path = temp_dir / "report.json"
        server_log_path = temp_dir / "server.log"
        initial_session = {
            "version": 1,
            "tabs": [
                {"id": "tab-1", "url": FIRST_URL, "title": "First fixture", "zoom": 1.25},
                {"id": "tab-2", "url": SECOND_URL, "title": "Second fixture", "zoom": 1.5},
            ],
            "activeTabId": "tab-2",
            "recentlyClosed": [],
        }
        session_path.write_text(json.dumps(initial_session))

        with server_log_path.open("w+") as server_log, tempfile.TemporaryFile(mode="w+t") as app_log:
            server = subprocess.Popen(
                [sys.executable, "tests/fixtures/server.py"],
                cwd=ROOT,
                stdout=server_log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            try:
                wait_for_server(server, server_log_path)
                downloads_dir = temp_dir / "downloads"
                exercise = run_phase("exercise", session_path, report_path, app_log, downloads_dir)
                if [tab["url"] for tab in exercise["snapshot"]["tabs"]] != [FIRST_URL, SECOND_URL]:
                    raise AssertionError(f"Reopened tab state was unexpected: {exercise['snapshot']}")
                wait_for_page_requests(server_log_path, {FIRST_URL: 1, SECOND_URL: 2})
                deadline = time.monotonic() + 10
                downloaded_file = downloads_dir / "download.txt"
                while time.monotonic() < deadline and not downloaded_file.exists():
                    time.sleep(0.1)
                if not downloaded_file.exists() or downloaded_file.stat().st_size == 0:
                    raise AssertionError("Native WKWebView did not save the downloaded fixture")
                if "DOWNLOAD /download.txt" not in server_log_path.read_text():
                    raise AssertionError("Fixture server did not receive the native download request")

                restore = run_phase("restore", session_path, report_path, app_log, downloads_dir)
                if [tab["url"] for tab in restore["snapshot"]["tabs"]] != [FIRST_URL, SECOND_URL]:
                    raise AssertionError(f"Restarted tab state was unexpected: {restore['snapshot']}")
                wait_for_page_requests(server_log_path, {FIRST_URL: 2, SECOND_URL: 3})
                print("PASS: native WKWebViews exercised find, new-tab links, tab cycling, downloads, history, and session restore")
            finally:
                stop_process(server)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(f"FAIL: {error}") from error
