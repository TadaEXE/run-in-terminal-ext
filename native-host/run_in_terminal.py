#!/usr/bin/env python3
import os, sys, json, struct, threading, base64, subprocess, time, traceback

IS_WIN = sys.platform == "win32"
LOG = os.path.expandvars(r"%TEMP%\rit_host.log") if IS_WIN else "/home/tada/Projects/run-in-terminal-ext/logs/rit.log"


def log(msg):
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%F %T')}] {msg}\n")
    except Exception:
        pass


def read_msg():
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


def send_msg(obj):
    b = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(len(b).to_bytes(4, "little"))
    sys.stdout.buffer.write(b)
    sys.stdout.buffer.flush()


def send_chunk(bs: bytes):
    send_msg({"type": "data", "data_b64": base64.b64encode(bs).decode("ascii")})


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
                self.winproc = pywinpty.Process(self.winpty, self.shell)
                self._reader = threading.Thread(target=self._read_winpty, daemon=True)
                self._reader.start()
                send_msg({"type": "ready", "platform": "win-pty", "shell": self.shell})
                return
            except Exception as e:
                log(f"pywinpty unavailable, fallback pipe: {e}")
                self.proc = subprocess.Popen(
                    [self.shell],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                )
                self._reader = threading.Thread(target=self._read_pipe, daemon=True)
                self._reader.start()
                send_msg({"type": "ready", "platform": "win-pipe", "shell": self.shell})
                return

        # POSIX PTY
        import pty, fcntl, termios, struct as st

        self.master_fd, self.slave_fd = pty.openpty()
        fcntl.ioctl(
            self.master_fd,
            termios.TIOCSWINSZ,
            st.pack("HHHH", self.rows, self.cols, 0, 0),
        )
        self.proc = subprocess.Popen(
            [self.shell, "-l"],
            stdin=self.slave_fd,
            stdout=self.slave_fd,
            stderr=self.slave_fd,
            start_new_session=True,
        )
        os.close(self.slave_fd)
        self._reader = threading.Thread(target=self._read_posix, daemon=True)
        self._reader.start()
        send_msg({"type": "ready", "platform": "posix-pty", "shell": self.shell})

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
                send_chunk(chunk)
        except OSError:
            pass
        send_msg({"type": "exit", "code": self.proc.poll() if self.proc else None})

    def _read_pipe(self):
        try:
            while True:
                b = self.proc.stdout.read(8192)
                if not b:
                    break
                send_chunk(b)
        except Exception:
            pass
        send_msg({"type": "exit", "code": self.proc.poll() if self.proc else None})

    def _read_winpty(self):
        try:
            while True:
                s = self.winpty.read(8192)
                if not s:
                    break
                send_chunk(s.encode("utf-8", "ignore"))
        except Exception:
            pass
        send_msg({"type": "exit", "code": 0})

    def close(self):
        try:
            if IS_WIN:
                if self.winproc:
                    self.winproc.kill()
                if self.proc:
                    self.proc.terminate()
            else:
                if self.proc:
                    self.proc.terminate()
                if self.master_fd:
                    os.close(self.master_fd)
        except Exception as e:
            log(f"close error: {e}")


def main():
    log(f"host start pid={os.getpid()}")
    pty = None
    while True:
        msg = read_msg()
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
                    send_msg({"type": "error", "message": "stdin before open"})
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
                    send_msg({"type": "exit", "code": 0})
            elif t == "ping":
                send_msg({"type": "pong"})
            else:
                send_msg({"type": "error", "message": f"unknown:{t}"})
        except Exception as e:
            log("handler error:\n" + traceback.format_exc())
            send_msg({"type": "error", "message": str(e)})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        log("fatal:\n" + traceback.format_exc())
