# Hi I'm Tada and this is untested python code
import base64
import json
import os
import socket
import time
import threading
import sys
import subprocess
from contextlib import contextmanager
from dataclasses import dataclass
from multiprocessing import  get_context
from multiprocessing.connection import Listener, Client, Connection
from pathlib import Path
from typing import Any, Callable, Dict, Optional

IS_WIN = os.name == "nt"


def _state_base_dir() -> Path:
    if IS_WIN:
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser(r"~\AppData\Local")
        return Path(base) / "run_in_terminal"

    base = os.path.expanduser("~/.local/state")
    return Path(base) / "run_in_terminal"


def _workers_dir() -> Path:
    p = _state_base_dir() / "workers"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _locks_dir() -> Path:
    p = _state_base_dir() / "locks"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _info_path(name: str) -> Path:
    return _workers_dir() / f"{name}.json"


def _lock_path(name: str) -> Path:
    return _locks_dir() / f"{name}.lock"


def _home_dir():
    return os.path.expanduser("~") or (os.environ.get("USERPROFILE") or os.getcwd())


@contextmanager
def _file_lock(path: Path, timeout: float = 10.0, poll: float = 0.05):
    path.parent.mkdir(parents=True, exist_ok=True)
    f = open(path, "a+b")
    start = time.time()
    if IS_WIN:
        import msvcrt

        locked = False
        try:
            while True:
                try:
                    msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                    locked = True
                    break
                except OSError:
                    if time.time() - start > timeout:
                        raise TimeoutError(f"Timeout acquiring lock: {path}")
                    time.sleep(poll)
            yield
        finally:
            try:
                if locked:
                    f.seek(0)
                    msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
            finally:
                f.close()
    else:
        import fcntl

        try:
            while True:
                try:
                    fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.time() - start > timeout:
                        raise TimeoutError(f"Timeout acquiring lock: {path}")
                    time.sleep(poll)
            yield
        finally:
            try:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)
            finally:
                f.close()


class PTYShell:
    def __init__(
        self,
        shell=None,
        cols=80,
        rows=24,
    ):
        self.shell = shell
        self.cols, self.rows = int(cols), int(rows)
        self.proc = None
        self.master_fd = None
        self.slave_fd = None
        self._reader = None
        self.winpty = None
        self.winproc = None
        self.spawned = False

    def _send_to_ext(self, obj: Any) -> None:
        try:
            if self.send_cb:
                self.send_cb(obj)
        except Exception:
            pass

    def _send_chunk_to_ext(self, bs: bytes) -> None:
        self._send_to_ext(
            {"type": "data", "data_b64": base64.b64encode(bs).decode("ascii")}
        )

    def _read_from_ext(self) -> Any:
        try:
            if self.read_cb:
                return self.read_cb()
        except Exception:
            return None

    def set_cbs(
        self, send_cb: Callable[[Any], None] | None, read_cb: Callable[[], Any] | None
    ):
        self.read_cb = read_cb
        self.send_cb = send_cb

    def spawn(self):
        # -> always start in the user's home directory
        try:
            os.chdir(_home_dir())
        except Exception:
            pass

        if not self.shell:
            self.shell = (
                (
                    os.environ.get("COMSPEC")
                    or r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
                )
                if IS_WIN
                else (os.environ.get("SHELL") or "/bin/bash")
            )

        if IS_WIN:
            try:
                import pywinpty

                self.winpty = pywinpty.PTY(cols=self.cols, rows=self.rows)
                # -> pywinpty inherits current working directory from this process after chdir
                self.winproc = pywinpty.Process(self.winpty, self.shell)
                self._reader = threading.Thread(target=self._read_winpty, daemon=True)
                self._reader.start()
                self._send_to_ext(
                    {"type": "ready", "platform": "win-pty", "shell": self.shell}
                )
                self.spawned = True
                return
            except Exception:
                self.proc = subprocess.Popen(
                    [self.shell],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    cwd=_home_dir(),  # -> ensure home on fallback
                )
                self._reader = threading.Thread(target=self._read_pipe, daemon=True)
                self._reader.start()
                self._send_to_ext(
                    {"type": "ready", "platform": "win-pipe", "shell": self.shell}
                )
                self.spawned = True
                return

        # POSIX PTY
        import pty, fcntl, termios, struct as st

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
            cwd=_home_dir(),  # -> ensure home on POSIX too
        )
        os.close(self.slave_fd)
        self._reader = threading.Thread(target=self._read_posix, daemon=True)
        self._reader.start()
        self._send_to_ext(
            {"type": "ready", "platform": "posix-pty", "shell": self.shell}
        )
        self.spawned = True

    def write(self, data: bytes):
        try:
            if IS_WIN:
                if self.winpty:
                    self.winpty.write(data.decode("utf-8", "ignore"))
                elif self.proc and self.proc.stdin:
                    self.proc.stdin.write(data)
                    self.proc.stdin.flush()
            elif self.master_fd:
                os.write(self.master_fd, data)
        except Exception:
            pass

    def resize(self, cols, rows):
        self.cols, self.rows = int(cols), int(rows)
        try:
            if IS_WIN and self.winpty:
                self.winpty.set_size(self.cols, self.rows)
            elif self.master_fd:
                import fcntl, termios, struct as st

                fcntl.ioctl(
                    self.master_fd,
                    termios.TIOCSWINSZ,
                    st.pack("HHHH", self.rows, self.cols, 0, 0),
                )
        except Exception:
            pass

    def _read_posix(self):
        try:
            while self.master_fd:
                chunk = os.read(self.master_fd, 8192)
                if not chunk:
                    break
                self._send_chunk_to_ext(chunk)
        except OSError:
            pass
        self._send_to_ext(
            {"type": "exit", "code": self.proc.poll() if self.proc else None}
        )

    def _read_pipe(self):
        try:
            while self.proc and self.proc.stdout:
                b = self.proc.stdout.read(8192)
                if not b:
                    break
                self._send_chunk_to_ext(b)
        except Exception:
            pass
        self._send_to_ext(
            {"type": "exit", "code": self.proc.poll() if self.proc else None}
        )

    def _read_winpty(self):
        try:
            while self.winpty:
                s = self.winpty.read(8192)
                if not s:
                    break
                self._send_chunk_to_ext(s.encode("utf-8", "ignore"))
        except Exception:
            pass
        self._send_to_ext({"type": "exit", "code": 0})

    def close(self, stop_event: threading.Event | None):
        if stop_event:
            stop_event.set()
        if not self.spawned:
            return

        try:
            if IS_WIN:
                try:
                    if self.winproc:
                        self.winproc.kill()
                except Exception:
                    pass
                try:
                    if self.proc:
                        self.proc.terminate()
                except Exception:
                    pass
                try:
                    if self.winpty:
                        # pywinpty objects close underlying handles
                        self.winpty.close()
                except Exception:
                    pass
            else:
                import signal

                if self.proc:
                    try:
                        # -> send SIGTERM to the whole process group
                        os.killpg(self.proc.pid, signal.SIGTERM)
                    except Exception:
                        pass
                        try:
                            self.proc.terminate()
                        except Exception:
                            pass
                    # -> wait briefly, then SIGKILL if needed
                    deadline = time.time() + 2.0
                    while time.time() < deadline:
                        if self.proc.poll() is not None:
                            break
                        time.sleep(0.05)
                    if self.proc.poll() is None:
                        try:
                            os.killpg(self.proc.pid, signal.SIGKILL)
                        except Exception:
                            pass
                if self.master_fd:
                    try:
                        os.close(self.master_fd)
                    except Exception:
                        pass
        except Exception:
            pass

    def tick(self, stop_event: threading.Event):
        msg = self._read_from_ext()
        if msg is None:
            self.close(stop_event)
            return
        t = msg.get("type")
        try:
            if t == "open":
                if self.spawned:
                    self.close(None)

                self.shell = msg.get("shell")
                self.cols = msg.get("cols", 100)
                self.rows = msg.get("rows", 30)
                self.spawn()
            elif t == "stdin":
                if not self.spawned:
                    send_to_ext({"type": "error", "message": "stdin before open"})
                else:
                    data = base64.b64decode(msg.get("data_b64", ""))
                    self.write(data)
            elif t == "resize":
                if self.spawned:
                    self.resize(msg.get("cols", 100), msg.get("rows", 30))
            elif t == "close":
                self.close(stop_event)
                send_to_ext({"type": "exit", "code": 0})
            elif t == "ping":
                send_to_ext({"type": "pong"})
            else:
                send_to_ext({"type": "error", "message": f"unknown:{t}"})
        except Exception as e:
            send_to_ext({"type": "error", "message": str(e)})


@dataclass
class WorkerInfo:
    name: str
    pid: int
    host: str
    port: int
    authkey_b64: str
    started_at: float

    @property
    def authkey(self) -> bytes:
        return base64.urlsafe_b64decode(self.authkey_b64.encode("ascii"))


class PTYDaemonWorker:
    name: str
    info: Optional[WorkerInfo]
    stop_event: threading.Event
    pty: PTYShell

    def __init__(self, name: str) -> None:
        self.name = name
        self.info = self._read_info()
        self.stop_event = threading.Event()

    def _read_info(self) -> Optional[WorkerInfo]:
        p = _info_path(self.name)
        if not p.exists():
            return None

        try:
            with p.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
            return WorkerInfo(**data)
        except Exception:
            return None

    def _write_info(self) -> None:
        if self.info is None:
            return

        p = _info_path(self.info.name)
        tmp = p.with_suffix(".json.tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(self.info.__dict__, fh)
        os.replace(tmp, p)

    def _remove_info(self) -> None:
        try:
            _info_path(self.name).unlink()
        except FileNotFoundError:
            pass

    def _try_connect(self, conn_timeout: float = 2.0) -> Optional[Connection]:
        if self.info is None:
            return None

        address = (self.info.host, int(self.info.port))
        try:
            old_to = socket.getdefaulttimeout()
            socket.setdefaulttimeout(conn_timeout)
            try:
                conn = Client(address, authkey=self.info.authkey)
            finally:
                socket.setdefaulttimeout(old_to)
            return conn
        except Exception:
            return None

    def _cleanup_if_stale(self) -> None:
        if not self.info:
            return
        conn = self._try_connect()

        if conn is None:
            self._remove_info()
        else:
            conn.close()

    def set_cbs(
        self, send_cb: Callable[[Any], None] | None, read_cb: Callable[[], Any]
    ):
        if not self.info:
            return
        conn = self._try_connect()
        if conn:
            conn.send({"cmd": "set", "read": read_cb, "send": send_cb})
            conn.recv()
            conn.close()

    def _worker_entry(self, host: str = "127.0.0.1") -> None:
        if os.fork() != 0:
            return

        import secrets

        authkey = secrets.token_bytes(32)

        listener = Listener((host, 0), authkey=authkey)
        port = listener.address[1]

        self.info = WorkerInfo(
            name=self.name,
            pid=os.getpid(),
            host=host,
            port=int(port),
            authkey_b64=base64.urlsafe_b64encode(authkey).decode("ascii"),
            started_at=time.time(),
        )
        self._write_info()

        def handle_client(conn: Connection):
            try:
                msg = None
                try:
                    msg = conn.recv()
                except EOFError:
                    pass

                if not isinstance(msg, dict) or "cmd" not in msg:
                    conn.send({"ok": False, "error": "invalid message"})
                    return

                cmd = msg["cmd"]
                if cmd == "ping":
                    conn.send({"ok": True, "pong": True, "name": self.name})
                elif cmd == "stop":
                    conn.send({"ok": True})
                    self.stop_event.set()
                elif cmd == "set":
                    try:
                        read = msg.get("read")
                        send = msg.get("send")
                        self.pty.set_cbs(send, read)
                        conn.send({"ok": True})
                    except Exception as e:
                        conn.send({"ok": False, "error": f"{type(e)}: {e}"})
                else:
                    conn.send({"ok": False, "error": f"unknown cmd: {cmd}"})
            finally:
                try:
                    conn.close()
                except Exception:
                    pass

        try:
            while not self.stop_event.is_set():
                try:
                    conn = listener.accept()
                except (OSError, EOFError):
                    continue
                handle_client(conn)
                self.pty.tick(self.stop_event)

        finally:
            try:
                listener.close()
            except Exception:
                pass
            self._remove_info()

    def start(self, ready_timeout: float = 5.0) -> None:
        with _file_lock(_lock_path(self.name), timeout=ready_timeout + 5):
            info = self._read_info()
            if info:
                conn = self._try_connect(conn_timeout=0.5)
                self.info = info
                return
            else:
                self._remove_info()

        ctx = get_context("spawn")
        proc = ctx.Process(target=self._worker_entry, daemon=True)
        proc.start()

        deadline = time.time() + ready_timeout
        info = None
        while time.time() < deadline:
            info = self._read_info()
            if info:
                conn = self._try_connect(conn_timeout=0.2)
                if conn:
                    conn.close()
                    self.info = info
            time.sleep(0.05)

        if info is None:
            self._remove_info()
        raise TimeoutError(
            f"Worker '{self.name}' did not start within {ready_timeout: .1f}s"
        )

    def send(
        self,
        payload: Any,
        timeout: float = 5.0,
        start_if_missing: bool = True,
    ) -> Any:
        if not self.info:
            if not start_if_missing:
                raise RuntimeError(f"No worker '{self.name}' foud")
            self.start(timeout)

        conn = self._try_connect(conn_timeout=timeout)
        if conn is None:
            self._cleanup_if_stale()
            if not start_if_missing:
                raise RuntimeError(f"Worker '{self.name}' not reachalbe")

            self.start(timeout)
            conn = self._try_connect(timeout)
            if conn is None:
                raise RuntimeError(f"Worker '{self.name}' unreachable after respawn")

        try:
            conn.send({"cmd": "request", "payload": payload})
            if not conn.poll(timeout):
                raise TimeoutError(f"Timed out waiting for reply from '{self.name}'")
            reply = conn.recv()
            if not isinstance(reply, dict) or not reply.get("ok", False):
                err = (reply or {}).get("error", "unknown error")
                raise RuntimeError(f"Worker '{self.name}' error: {err}")
            return reply.get("result")
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def ping(self, timeout: float = 1.0) -> bool:
        if not self.info:
            return False

        conn = self._try_connect(timeout)
        if conn is None:
            self._cleanup_if_stale()
            return False

        try:
            conn.send({"cmd": "ping"})
            if not conn.poll(timeout):
                return False
            reply = conn.recv()
            return bool(isinstance(reply, dict) and reply.get("pong"))
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def stop(self, timeout: float = 2.0) -> bool:
        if not self.info:
            return True
        conn = self._try_connect(0.5)
        if conn is None:
            self._cleanup_if_stale()
            return True
        try:
            conn.send({"cmd": "stop"})
            conn.poll(timeout)
            return True
        finally:
            try:
                conn.close()
            except Exception:
                pass


def list_known_workers() -> Dict[str, WorkerInfo]:
    out: Dict[str, WorkerInfo] = {}
    for p in _workers_dir().glob("*.json"):
        try:
            with p.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
                info = WorkerInfo(**data)
                out[info.name] = info

        except Exception:
            continue
    return out


def read_from_ext() -> Optional[Any]:
    hdr = sys.stdin.buffer.read(4)
    if not hdr:
        return None
    n = int.from_bytes(hdr, "little")
    data = sys.stdin.buffer.read(n)
    try:
        return json.loads(data.decode("utf-8"))
    except Exception:
        return None


def send_to_ext(obj: Any) -> None:
    b = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(len(b).to_bytes(4, "little"))
    sys.stdout.buffer.write(b)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    w = PTYDaemonWorker("test")
    w.start()
    w.ping()
