#!/usr/bin/env python3
import os
import sys
import json
import threading
import base64
import subprocess
import time
import traceback

IS_WIN = sys.platform == "win32"
LOG = (
    os.path.expandvars(r"%TEMP%\rit_host.log")
    if IS_WIN
    else "/home/tada/Projects/run-in-terminal-ext/logs/rit.log"
)

LOGGING_ENABLED = True


def log(msg):
    if not LOGGING_ENABLED:
        return
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%F %T')}] {msg}\n")
    except Exception:
        pass


def read_from_ext():
    hdr = sys.stdin.buffer.read(4)
    if not hdr:
        return None
    n = int.from_bytes(hdr, "little")
    data = sys.stdin.buffer.read(n)
    try:
        return json.loads(data.decode("utf-8"))
    except Exception:
        log(f"JSON decode error: {data!r}")
        return None


def send_to_ext(obj):
    b = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(len(b).to_bytes(4, "little"))
    sys.stdout.buffer.write(b)
    sys.stdout.buffer.flush()


def send_chunk_to_ext(bs: bytes):
    send_to_ext({"type": "data", "data_b64": base64.b64encode(bs).decode("ascii")})


def home_dir():
    return os.path.expanduser("~") or (os.environ.get("USERPROFILE") or os.getcwd())


class PTYShell:
    def __init__(self, shell=None, cols=80, rows=24):
        self.shell = shell
        self.cols, self.rows = int(cols), int(rows)
        self.proc = None
        self.master_fd = None
        self.slave_fd = None
        self._reader = None
        self.winpty = None
        self.winproc = None

    def spawn(self):
        # -> always start in the user's home directory
        try:
            os.chdir(home_dir())
        except Exception as e:
            log(f"chdir failed: {e}")

        if not self.shell:
            self.shell = (
                (
                    os.environ.get("COMSPEC")
                    or r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
                )
                if IS_WIN
                else (os.environ.get("SHELL") or "/bin/bash")
            )
        log(f"Spawning shell: {self.shell} [{self.cols}x{self.rows}]")
        if IS_WIN:
            try:
                import pywinpty

                self.winpty = pywinpty.PTY(cols=self.cols, rows=self.rows)
                # -> pywinpty inherits current working directory from this process after chdir
                self.winproc = pywinpty.Process(self.winpty, self.shell)
                self._reader = threading.Thread(target=self._read_winpty, daemon=True)
                self._reader.start()
                send_to_ext({"type": "ready", "platform": "win-pty", "shell": self.shell})
                return
            except Exception as e:
                log(f"pywinpty unavailable, fallback pipe: {e}")
                self.proc = subprocess.Popen(
                    [self.shell],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    cwd=home_dir(),  # -> ensure home on fallback
                )
                self._reader = threading.Thread(target=self._read_pipe, daemon=True)
                self._reader.start()
                send_to_ext({"type": "ready", "platform": "win-pipe", "shell": self.shell})
                return

        # POSIX PTY
        import pty, fcntl, termios, struct as st, signal

        self.master_fd, self.slave_fd = pty.openpty()
        fcntl.ioctl(
            self.master_fd,
            termios.TIOCSWINSZ,
            st.pack("HHHH", self.rows, self.cols, 0, 0),
        )
        # -> start_new_session makes the child a session leader so we can kill the whole group
        self.proc = subprocess.Popen(
            [self.shell, "-l"],
            stdin=self.slave_fd,
            stdout=self.slave_fd,
            stderr=self.slave_fd,
            start_new_session=True,
            cwd=home_dir(),  # -> ensure home on POSIX too
        )
        os.close(self.slave_fd)
        self._reader = threading.Thread(target=self._read_posix, daemon=True)
        self._reader.start()
        send_to_ext({"type": "ready", "platform": "posix-pty", "shell": self.shell})

    def write(self, data: bytes):
        try:
            if IS_WIN:
                if self.winpty:
                    self.winpty.write(data.decode("utf-8", "ignore"))
                elif self.proc and self.proc.stdin:
                    self.proc.stdin.write(data)
                    self.proc.stdin.flush()
            else:
                os.write(self.master_fd, data)
        except Exception as e:
            log(f"write error: {e}")

    def resize(self, cols, rows):
        self.cols, self.rows = int(cols), int(rows)
        try:
            if IS_WIN and self.winpty:
                self.winpty.set_size(self.cols, self.rows)
            else:
                import fcntl, termios, struct as st

                fcntl.ioctl(
                    self.master_fd,
                    termios.TIOCSWINSZ,
                    st.pack("HHHH", self.rows, self.cols, 0, 0),
                )
        except Exception as e:
            log(f"resize error: {e}")

    def _read_posix(self):
        try:
            while True:
                chunk = os.read(self.master_fd, 8192)
                if not chunk:
                    break
                send_chunk_to_ext(chunk)
        except OSError:
            pass
        send_to_ext({"type": "exit", "code": self.proc.poll() if self.proc else None})

    def _read_pipe(self):
        try:
            while True:
                b = self.proc.stdout.read(8192)
                if not b:
                    break
                send_chunk_to_ext(b)
        except Exception:
            pass
        send_to_ext({"type": "exit", "code": self.proc.poll() if self.proc else None})

    def _read_winpty(self):
        try:
            while True:
                s = self.winpty.read(8192)
                if not s:
                    break
                send_chunk_to_ext(s.encode("utf-8", "ignore"))
        except Exception:
            pass
        send_to_ext({"type": "exit", "code": 0})

    def close(self):
        # -> stronger cleanup: terminate process group on POSIX, close PTY handles
        try:
            if IS_WIN:
                try:
                    if self.winproc:
                        self.winproc.kill()
                except Exception as e:
                    log(f"winproc kill error: {e}")
                try:
                    if self.proc:
                        self.proc.terminate()
                except Exception as e:
                    log(f"win pipe terminate error: {e}")
                try:
                    if self.winpty:
                        # pywinpty objects close underlying handles
                        self.winpty.close()
                except Exception as e:
                    log(f"winpty close error: {e}")
            else:
                import signal

                if self.proc:
                    try:
                        # -> send SIGTERM to the whole process group
                        os.killpg(self.proc.pid, signal.SIGTERM)
                    except Exception as e:
                        log(f"killpg SIGTERM error: {e}")
                        try:
                            self.proc.terminate()
                        except Exception as e2:
                            log(f"proc terminate error: {e2}")
                    # -> wait briefly, then SIGKILL if needed
                    deadline = time.time() + 2.0
                    while time.time() < deadline:
                        if self.proc.poll() is not None:
                            break
                        time.sleep(0.05)
                    if self.proc.poll() is None:
                        try:
                            os.killpg(self.proc.pid, signal.SIGKILL)
                        except Exception as e:
                            log(f"killpg SIGKILL error: {e}")
                if self.master_fd:
                    try:
                        os.close(self.master_fd)
                    except Exception as e:
                        log(f"close master_fd error: {e}")
        except Exception as e:
            log(f"close error: {e}")


def main():
    log(f"host start pid={os.getpid()}")
    pty = None
    while True:
        msg = read_from_ext()
        log(f"recv: {msg!r}")
        if msg is None:
            log("EOF from browser; exiting")
            if pty:
                pty.close()
            return
        t = msg.get("type")
        try:
            if t == "open":
                if pty:
                    pty.close()
                pty = PTYShell(
                    shell=msg.get("shell"),
                    cols=msg.get("cols", 100),
                    rows=msg.get("rows", 30),
                )
                pty.spawn()
            elif t == "stdin":
                if not pty:
                    send_to_ext({"type": "error", "message": "stdin before open"})
                else:
                    data = base64.b64decode(msg.get("data_b64", ""))
                    pty.write(data)
            elif t == "resize":
                if pty:
                    pty.resize(msg.get("cols", 100), msg.get("rows", 30))
            elif t == "close":
                if pty:
                    pty.close()
                    pty = None
                    send_to_ext({"type": "exit", "code": 0})
            elif t == "ping":
                send_to_ext({"type": "pong"})
            else:
                send_to_ext({"type": "error", "message": f"unknown:{t}"})
        except Exception as e:
            log("handler error:\n" + traceback.format_exc())
            send_to_ext({"type": "error", "message": str(e)})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        log("fatal:\n" + traceback.format_exc())
