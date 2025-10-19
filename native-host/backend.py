# Hi I'm Tada and this is untested python code
import base64
import json
import os
import socket
import time
import threading
import sys
import subprocess
import traceback
from contextlib import contextmanager
from dataclasses import dataclass
from multiprocessing import current_process, get_context
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


def _read_info(name: str) -> Optional[WorkerInfo]:
    p = _info_path(name)
    if not p.exists():
        return None

    try:
        with p.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        return WorkerInfo(**data)
    except Exception:
        return None


def _write_info(info: WorkerInfo) -> None:
    p = _info_path(info.name)
    tmp = p.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(info.__dict__, fh)
    os.replace(tmp, p)


def _remove_info(name: str) -> None:
    try:
        _info_path(name).unlink()
    except FileNotFoundError:
        pass


def _try_connect(info: WorkerInfo, conn_timeout: float = 2.0) -> Optional[Connection]:
    address = (info.host, int(info.port))
    try:
        old_to = socket.getdefaulttimeout()
        socket.setdefaulttimeout(conn_timeout)
        try:
            conn = Client(address, authkey=info.authkey)
        finally:
            socket.setdefaulttimeout(old_to)
        return conn
    except Exception:
        return None


def _cleanup_if_stale(name: str) -> None:
    info = _read_info(name)
    if not info:
        return
    conn = _try_connect(info, conn_timeout=0.5)

    if conn is None:
        _remove_info(name)
    else:
        conn.close()


def _worker_entry(
    name: str, handler: Callable[[Any], Any], host: str = "127.0.0.1"
) -> None:
    if os.fork() != 0:
        return

    import secrets

    authkey = secrets.token_bytes(32)

    listener = Listener((host, 0), authkey=authkey)
    port = listener.address[1]

    info = WorkerInfo(
        name=name,
        pid=os.getpid(),
        host=host,
        port=int(port),
        authkey_b64=base64.urlsafe_b64encode(authkey).decode("ascii"),
        started_at=time.time(),
    )
    _write_info(info)

    stop_event = threading.Event()

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
                conn.send({"ok": True, "pong": True, "name": name})
            elif cmd == "stop":
                conn.send({"ok": True})
                stop_event.set()
            elif cmd == "request":
                try:
                    res = handler(msg.get("payload"))
                    conn.send({"ok": True, "result": res})
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
        while not stop_event.is_set():
            try:
                conn = listener.accept()
            except (OSError, EOFError):
                continue
            handle_client(conn)
    finally:
        try:
            listener.close()
        except Exception:
            pass
        _remove_info(name)


def ensure_worker(
    name: str, handler: Callable[[Any], Any], *, ready_timeout: float = 5.0
) -> WorkerInfo:
    with _file_lock(_lock_path(name), timeout=ready_timeout + 5):
        info = _read_info(name)
        if info:
            conn = _try_connect(info, conn_timeout=0.5)
            return info
        else:
            _remove_info(name)

    ctx = get_context("spawn")
    proc = ctx.Process(target=_worker_entry, args=(name, handler), daemon=True)
    proc.start()

    deadline = time.time() + ready_timeout
    info = None
    while time.time() < deadline:
        info = _read_info(name)
        if info:
            conn = _try_connect(info, conn_timeout=0.2)
            if conn:
                conn.close()
                return info
        time.sleep(0.05)

    if info is None:
        _remove_info(name)
    raise TimeoutError(f"Worker '{name}' did not start within {ready_timeout: .1f}s")


def send_to_worker(
    name: str,
    payload: Any,
    *,
    timeout: float = 5.0,
    start_if_missing: bool = False,
    handler_if_spawn: Optional[Callable[[Any], Any]] = None,
) -> Any:
    info = _read_info(name)
    if not info:
        if not start_if_missing:
            raise RuntimeError(f"No worker '{name}' foud")
        if handler_if_spawn is None:
            raise ValueError(
                "handler_if_spawn must be provided when using start_if_missing=True"
            )
        info = ensure_worker(name, handler_if_spawn, ready_timeout=timeout)

    conn = _try_connect(info, conn_timeout=timeout)
    if conn is None:
        _cleanup_if_stale(name)
        if not start_if_missing:
            raise RuntimeError(f"Worker '{name}' not reachalbe")
        if handler_if_spawn is None:
            raise ValueError(
                "handler_if_spawn must be provided when using start_if_missing=True"
            )
        info = ensure_worker(name, handler_if_spawn, ready_timeout=timeout)
        conn = _try_connect(info, conn_timeout=timeout)
        if conn is None:
            raise RuntimeError(f"Worker '{name}' unreachable after respawn")

    try:
        conn.send({"cmd": "request", "payload": payload})
        if not conn.poll(timeout):
            raise TimeoutError(f"Timed out waiting for reply from '{name}'")
        reply = conn.recv()
        if not isinstance(reply, dict) or not reply.get("ok", False):
            err = (reply or {}).get("error", "unknown error")
            raise RuntimeError(f"Worker '{name}' error: {err}")
        return reply.get("result")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def ping_worker(name: str, *, timeout: float = 1.0) -> bool:
    info = _read_info(name)
    if not info:
        return False

    conn = _try_connect(info, conn_timeout=timeout)
    if conn is None:
        _cleanup_if_stale(name)
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


def stop_worker(name: str, *, timeout: float = 2.0) -> bool:
    info = _read_info(name)
    if not info:
        return True
    conn = _try_connect(info, conn_timeout=0.5)
    if conn is None:
        _cleanup_if_stale(name)
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


def send_chunk_to_ext(bs: bytes):
    send_to_ext({"type": "data", "data_b64": base64.b64encode(bs).decode("ascii")})

def echo_handler(payload: Any) -> Any:
    return {"echo": payload, "mppid": current_process().pid, "ospid": os.getpid()}


if __name__ == "__main__":
    print(list_known_workers())
