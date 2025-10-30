import base64
from datetime import datetime
import json
import os
import sys
import threading
import time
import subprocess
import secrets
from dataclasses import dataclass, asdict
from multiprocessing.connection import Connection, Listener, Client
from pathlib import Path
from typing import Literal, Optional, Dict, Any, Set


IS_WIN = sys.platform == "win32"
ENABLE_LOGGING: Literal["file"] | Literal["print"] | Literal["off"] = "file"


def home_dir() -> str:
    """
    Return users home dir.
    """
    if IS_WIN:
        return (
            os.path.expandvars(r"%USERPROFILE")
            or os.path.expandvars(r"%HOMEDRIVE%HOMEPATH%")
            or os.getcwd()
        )
    return os.path.expanduser("~") or os.getcwd()


def base_dir() -> Path:
    """
    Return base dir where data is stored.
    """
    if IS_WIN:
        tmp = os.path.join(
            os.path.expandvars(r"%LOCALAPPDATA%") or os.getcwd(), "run_in_terminal"
        )
        p = Path(tmp)
        p.mkdir(parents=True, exist_ok=True)
        return p

    if sys.platform == "darwin":
        p = Path(os.path.expanduser("~/Library/Application Support/run_in_terminal"))
        p.mkdir(parents=True, exist_ok=True)
        return p

    xdg = os.environ.get("XDG_STATE_HOME")
    if xdg:
        p = Path(xdg) / "run_in_terminal"
        p.mkdir(parents=True, exist_ok=True)
        return p

    p = Path(os.path.expanduser("~/.local/state/run_in_terminal"))
    p.mkdir(parents=True, exist_ok=True)
    return p


def workers_dir() -> Path:
    """
    Return path to all workers.
    """
    p = base_dir() / "workers"
    p.mkdir(parents=True, exist_ok=True)
    return p


def worker_path(name: str) -> Path:
    """
    Returns path to named worker.
    """
    return workers_dir() / f"{name}.json"


def log_path() -> Path:
    """
    Return path to log file
    """
    return base_dir() / "rit.log"


def log(l: str) -> None:
    """
    Log any string to central log file.
    """
    t_fmt = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if ENABLE_LOGGING == "print":
        print(f"<{t_fmt}> {l}")
    elif ENABLE_LOGGING == "file":
        with open(log_path(), "a+", encoding="utf-8") as f:
            f.write(f"<{t_fmt}> {l}\n")
            f.flush()


@dataclass
class WorkerInfo:
    """
    Serializable coordinates for a live session daemon.
    name: unique session name
    pid: os pid of the daemon
    host: listening interface for the connection server
    port: listening port number
    authkey_b64: urlsafe base64 of the authentication key used by multiprocessing.connection
    started_at: unix timestamp when the daemon published itself
    """

    name: str
    pid: int
    host: str
    port: int
    authkey_b64: str
    started_at: float


def write_info(info: WorkerInfo) -> None:
    p = worker_path(info.name)
    tmp = p.with_suffix(".tmp")
    data = json.dumps(asdict(info), separators=(",", ":"), ensure_ascii=True).encode(
        "utf-8"
    )
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()

    os.replace(tmp, p)


def read_info(name: str) -> Optional[WorkerInfo]:
    """
    Read info file, if it exists.
    Returns none if not found.
    """
    p = worker_path(name)
    try:
        with open(p, "rb") as f:
            obj = json.loads(f.read().decode("utf-8"))
            return WorkerInfo(
                name=obj["name"],
                pid=int(obj["pid"]),
                host=str(obj["host"]),
                port=int(obj["port"]),
                authkey_b64=str(obj["authkey_b64"]),
                started_at=float(obj["started_at"]),
            )
    except Exception as e:
        log(f"Failed reading info file for {name}. ({e})")
        return None


def remove_info(name: str) -> None:
    """
    Remove info file, if it exists
    """
    log(f"Removing info {name}")
    p = worker_path(name)
    try:
        p.unlink()
    except Exception as e:
        log(f"Failed removing info file for {name}. ({e})")


def decode_authkey(b64: str) -> bytes:
    return base64.urlsafe_b64decode(b64.encode("ascii"))


def try_connect(info: WorkerInfo) -> Optional[Connection]:
    """
    Tries to connect to given daemon worker.
    Returns a Client connection, if successful
    """
    try:
        conn = Client((info.host, info.port), authkey=decode_authkey(info.authkey_b64))
        return conn
    except Exception as e:
        log(f"Failed to connect to {info.name} on {info.host}:{info.port} ({e})")


def spawn_detached_daemon(
    name: str, shell: Optional[str], cols: int, rows: int
) -> None:
    """
    Spawns a detached child process => Runs this with `--ssesion-daemon`
    """
    exe = sys.executable
    this = str(Path(__file__).resolve())
    shell_arg = shell if shell else "_"
    args = [
        exe,
        this,
        "--session-daemon",
        name,
        shell_arg,
        str(cols),
        str(rows),
    ]
    if IS_WIN:
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        DETACHED_PROCESS = 0x00000008
        creationflags = CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS
        subprocess.Popen(args, creationflags=creationflags, close_fds=True)
    else:
        subprocess.Popen(args, close_fds=True)


def ensure_session(
    name: str, shell: Optional[str], cols: int, rows: int, timeout: float = 5.0
) -> Connection:
    """
    Connects to a session, if it exists.
    Will create one and then connect otherwise.
    """
    info = read_info(name)
    if info:
        conn = try_connect(info)
        if conn:
            return conn
    spawn_detached_daemon(name, shell, cols, rows)
    # wait for session to self-publish
    deadline = time.time() + timeout
    while time.time() < deadline:
        info = read_info(name)
        if info:
            conn = try_connect(info)
            if conn:
                log(f"Session for {name} created and reachable.")
                return conn
        time.sleep(timeout / 100)

    log(f"Session for {name} was not reachable after {timeout}s. Abort!")
    raise RuntimeError(f"Session for {name} was not reachable after {timeout}s. Abort!")


def read_from_ext() -> Optional[Dict[str, Any]]:
    """
    Reads one Native Messaging JSON message from stdin. Returns None on EOF.
    """
    hdr = sys.stdin.buffer.read(4)
    if not hdr:
        return None
    n = int.from_bytes(hdr, "little")
    data = sys.stdin.buffer.read(n)
    try:
        return json.loads(data.decode("utf-8"))
    except Exception:
        log(f"Received invalid json from native host: \n{data}")
        return None


def send_to_ext(obj: Dict[str, Any]) -> None:
    """
    Sends one Native Messaging JSON message to stdout.
    """
    b = json.dumps(obj, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    sys.stdout.buffer.write(len(b).to_bytes(4, "little"))
    sys.stdout.buffer.write(b)
    sys.stdout.buffer.flush()


def forward_chunk_to_ext(b64_bs: bytes) -> None:
    """
    Forwards an already encoded data chunk to the extsnsion as a base64 JSON message.
    """
    send_to_ext({"type": "data", "data_b64": b64_bs})


def send_chunk_to_ext(bs: bytes) -> None:
    """
    Sends a terminal data chunk to the extension as a base64 JSON message.
    """
    send_to_ext({"type": "data", "data_b64": base64.b64encode(bs).decode("ascii")})


class DaemonClient:
    """
    Host-side bridge to a persistent session daemon.
    """

    session_name: str
    conn: Optional[Connection] = None
    _reader_thread: Optional[threading.Thread] = None
    _close_event: threading.Event = threading.Event()

    def __init__(self, session_name: str):
        self.session_name = session_name

    def connect_or_spawn(self, shell: Optional[str], cols: int, rows: int) -> None:
        """
        Connect to an existing session or spawn and connect
        """
        self.conn = ensure_session(self.session_name, shell, cols, rows)
        self._reader_thread = threading.Thread(
            target=self._reader_loop,
            name=f"run_in_terminal_daemon_client_{self.session_name}",
            daemon=True,
        )
        self._reader_thread.start()

    def _reader_loop(self) -> None:
        """
        Receives events fromthe daemon and forwards them to the extension.
        """
        try:
            log(f"Reader thread {self.session_name} started")
            while not self._close_event.is_set() and self.conn:
                try:
                    msg = self.conn.recv()
                    if isinstance(msg, dict):
                        t = msg.get("type")
                        if t == "data":
                            b64 = msg.get("data_b64", "")
                            forward_chunk_to_ext(b64)
                        else:
                            send_to_ext(msg)

                except EOFError:
                    break
        finally:
            try:
                log(f"Reader thread {self.session_name} terminated")
                if self.conn:
                    self.conn.close()
            except Exception:
                pass

    def stdin(self, data: bytes) -> None:
        """
        Send stdin data to the daemon
        """

        if self.conn:
            self.conn.send(
                {"cmd": "stdin", "data_b64": base64.b64encode(data).decode("ascii")}
            )

    def resize(self, cols: int, rows: int) -> None:
        """
        Request a terminal resize in the daemon.
        """
        if self.conn:
            self.conn.send({"cmd": "resize", "cols": int(cols), "rows": int(rows)})

    def ping(self) -> None:
        """
        Pings the daemon
        """
        if self.conn:
            self.conn.send({"cmd": "ping"})

    def close(self) -> None:
        """ """
        self._close_event.set()
        log(f"DaemonClient {self.session_name} closed")
        try:
            if self.conn:
                self.conn.send({"cmd": "close"})
                self.conn.close()
        except Exception:
            pass


class PTYShell:
    shell: Optional[str]
    cols: int
    rows: int
    proc: Optional[subprocess.Popen[bytes]] = None
    master_fd: Optional[int] = None
    slave_fd: Optional[int] = None
    _close_event: threading.Event = threading.Event()

    def __init__(self, shell: Optional[str] = None, cols: int = 80, rows: int = 24):
        self.shell = shell
        self.cols = cols
        self.rows = rows

    def spawn(self) -> str:
        """
        Spawns the shell at user home dir.
        Returns platform identifier.
        """

        try:
            os.chdir(home_dir())
        except Exception:
            pass

        if not self.shell:
            if IS_WIN:
                self.shell = (
                    os.environ.get("COMSPEC")
                    or r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
                )
            else:
                self.shell = os.environ.get("SHELL") or "/bin/bash"

        if IS_WIN:
            try:
                import pywinpty

                self.winpty = pywinpty.PTY(cols=self.cols, rows=self.rows)
                self.winproc = pywinpty.Process(self.winpty, self.shell)
                return "win-pty"
            except Exception:
                self.proc = subprocess.Popen(
                    [self.shell],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    cwd=home_dir(),
                )
                return "win-pipe"

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
            cwd=home_dir(),
        )
        os.close(self.slave_fd)
        return "posix-pty"

    def read_chunk(self, n: int = 8192) -> bytes:
        """
        Read up to n bytes from the terminal
        """
        if IS_WIN:
            if self.winpty:
                s = self.winpty.read(n)
                return (s or "").encode("utf-8", "ignore")
            if self.proc and self.proc.stdout:
                return self.proc.stdout.read(n) or b""
            return b""

        try:
            return os.read(self.master_fd, n) if self.master_fd else b""
        except Exception:
            return b""

    def write(self, data: bytes) -> None:
        """
        Write bytes to terminal
        """
        if IS_WIN:
            if self.winpty:
                self.winpty.write(data.decode("utf-8", "ignore"))
                return
            if self.proc and self.proc.stdin:
                self.proc.stdin.write(data)
                self.proc.stdin.flush()
                return
        if self.master_fd:
            os.write(self.master_fd, data)

    def resize(self, cols: int, rows: int) -> None:
        """
        Resize the terminal window
        """
        self.cols = cols
        self.rows = rows

        if IS_WIN and self.winpty:
            self.winpty.set_size(self.cols, self.rows)
            return
        if self.master_fd:
            import fcntl, termios, struct as st

            fcntl.ioctl(
                self.master_fd,
                termios.TIOCSWINSZ,
                st.pack("HHHH", self.rows, self.cols, 0, 0),
            )

    def poll_exit_code(self) -> Optional[int]:
        """
        Returns process exit code if exited, otherwise None
        """
        if IS_WIN and self.winpty:
            return None
        if self.proc:
            return self.proc.poll()
        return None

    def close(self) -> None:
        """
        Terminates the child process and closes file descriptors.
        """
        if self._close_event.is_set():
            return
        self._close_event.set()
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
                        self.winpty.close()
                except Exception:
                    pass
            else:
                import signal

                if self.proc:
                    try:
                        os.killpg(self.proc.pid, signal.SIGTERM)
                    except Exception:
                        try:
                            self.proc.terminate()
                        except Exception:
                            pass
                    deadline = time.time() + 2.0
                    while time.time() < deadline and self.proc.poll() is None:
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


class SessionServer:
    """
    A single session daemon owning one PTY and serving multiple clients.
    Clients connect using multiprocessing.connection with an auth key from WorkerInfo.
    Incoming commands: stdin, resize, ping, info, close.
    Outgoing events: ready, data, exit, pong, info.
    """

    name: str
    shell: Optional[str]
    cols: int
    rows: int
    stop_evt: threading.Event = threading.Event()
    clients: Set[Connection] = set()
    clients_lock: threading.Lock = threading.Lock()
    pty: PTYShell
    platform: Optional[str] = None

    def __init__(self, name: str, shell: Optional[str], cols: int, rows: int):
        self.name = name
        self.shell = shell
        self.cols = cols
        self.rows = rows
        self.pty = PTYShell(shell=shell, cols=self.cols, rows=self.rows)

    def broadcast(self, msg: Dict[str, Any]) -> None:
        """
        Sends a dict event to all connected clients, pruning broken connections.
        """
        dead = []
        with self.clients_lock:
            for c in list(self.clients):
                try:
                    c.send(msg)
                except Exception:
                    dead.append(c)
            for c in dead:
                try:
                    c.close()
                except Exception:
                    pass
                self.clients.discard(c)

    def _accept_loop(self, listener: Listener) -> None:
        """
        Accepts clients and serves each in a thread.
        """
        while not self.stop_evt.is_set():
            try:
                conn = listener.accept()
                if self.stop_evt.is_set():
                    break

                t = threading.Thread(
                    target=self._client_loop,
                    name=f"run_in_terminal_client_loop_{self.name}",
                    args=(conn,),
                    daemon=True,
                )
                t.start()
            except Exception:
                continue
        log(f"SessionSever[{self.name}] accept loop ended")

    def _client_loop(self, conn: Connection) -> None:
        """
        Handles one client connection.
        """
        try:
            conn.send(
                {
                    "type": "ready",
                    "session": self.name,
                    "platform": self.platform,
                    "shell": self.shell,
                }
            )
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
            return

        with self.clients_lock:
            self.clients.add(conn)
        try:
            while not self.stop_evt.is_set():
                try:
                    msg = conn.recv()
                except EOFError:
                    continue

                if not isinstance(msg, dict):
                    continue

                cmd = msg.get("cmd")
                if cmd == "stdin":
                    b64 = msg.get("data_b64", "")
                    if b64:
                        try:
                            self.pty.write(base64.b64decode(b64))
                        except Exception:
                            pass
                elif cmd == "resize":
                    self.pty.resize(
                        msg.get("cols", self.cols), msg.get("rows", self.rows)
                    )
                elif cmd == "ping":
                    try:
                        conn.send({"type": "pong"})
                    except Exception:
                        pass
                elif cmd == "info":
                    try:
                        conn.send(
                            {
                                "type": "info",
                                "session": self.name,
                                "platform": self.platform,
                                "shell": self.shell,
                            }
                        )
                    except Exception:
                        pass
                elif cmd == "close":
                    log(f"SessionSever[{self.name}] client loop closing")
                    self.close()
                    break
        finally:
            self.stop_evt.set()
            with self.clients_lock:
                if conn in self.clients:
                    self.clients.remove(conn)
            try:
                conn.close()
            except Exception:
                pass

    def _pty_reader(self) -> None:
        """
        Reads from the PTY and broadcasts data events until the PTY closes.
        """
        while not self.stop_evt.is_set():
            chunk = self.pty.read_chunk()
            if not chunk:
                code = self.pty.poll_exit_code()
                if code is not None or IS_WIN:
                    break
                time.sleep(0.02)
                continue
            self.broadcast(
                {"type": "data", "data_b64": base64.b64encode(chunk).decode("ascii")}
            )
        self.broadcast({"type": "exit", "code": self.pty.poll_exit_code()})
        log(f"SessionSever[{self.name}] pty reader ended")

    def run(self) -> None:
        """
        Starts the PTY, publishes WorkerInfo, and serves until stopped or PTY exit.
        """
        self.authkey = secrets.token_bytes(32)
        self.listener = Listener(("127.0.0.1", 0), authkey=self.authkey)
        self.host, self.port = self.listener.address
        self.platform = self.pty.spawn()
        info = WorkerInfo(
            name=self.name,
            pid=os.getpid(),
            host=str(self.host),
            port=int(self.port),
            authkey_b64=base64.urlsafe_b64encode(self.authkey).decode("ascii"),
            started_at=time.time(),
        )
        write_info(info)
        try:
            t = threading.Thread(
                target=self._pty_reader,
                name=f"run_in_terminal_pty_reader_{self.name}",
                daemon=True,
            )
            t.start()
            self._accept_loop(self.listener)
        finally:
            self.close()

    def close(self):
        log(f"SessionSever[{self.name}] closing")
        self.stop_evt.set()

        # Because Listener.accept has no timeout we connect so it can see the stop event
        with Client((self.host, int(self.port)), authkey=self.authkey) as c:
            c.send({})

        for conn in self.clients:
            try:
                conn.send({"cmd": "close"})
                conn.close()
            except Exception as e:
                log(f"SessionSever[{self.name}] failed to close conn: {e}")

        try:
            self.listener.close()
        except Exception:
            log(f"SessionSever[{self.name}] couldn't close listener")

        try:
            self.pty.close()
        except Exception:
            log(f"SessionSever[{self.name}] couldn't close pty")

        remove_info(self.name)
        log(f"SessionSever[{self.name}] closed")


def daemon_detach_posix() -> None:
    """
    Detaches the current process from the parent on POSIX so it outlives the host.
    """
    if os.fork() != 0:
        os._exit(0)
    os.setsid()
    if os.fork() != 0:
        os._exit(0)
    try:
        sys.stdin.close()
        sys.stdout.close()
        sys.stderr.close()
    except Exception:
        pass


def session_main(name: str, shell_token: str, cols: str, rows: str) -> None:
    """
    Entry point for session daemon mode. shell_token is "_" for default shell.
    """
    log(f"Session {name} started.")
    if not IS_WIN:
        daemon_detach_posix()
    shell = None if shell_token == "_" else shell_token
    srv = SessionServer(name=name, shell=shell, cols=int(cols), rows=int(rows))
    srv.run()


def host_main() -> None:
    """
    Entry point for host mode. Reads messages from the extension, attaches to a session daemon,
    and bridges messages in both directions. The session continues to live after host exit.
    """
    log("Started native host")
    session = None
    client = None
    shell = None
    cols = 100
    rows = 30
    received_close = False
    try:
        while not received_close:
            msg = read_from_ext()
            if msg is None:
                if client:
                    try:
                        client.close()
                    except Exception:
                        pass
                return
            try:
                t = msg.get("type")
                if t == "open":
                    session = msg.get("session") or "default"
                    shell = msg.get("shell")
                    cols = int(msg.get("cols", cols))
                    rows = int(msg.get("rows", rows))
                    client = DaemonClient(session)
                    client.connect_or_spawn(shell=shell, cols=cols, rows=rows)
                elif t == "stdin":
                    if not client:
                        send_to_ext({"type": "error", "message": "stdin before open"})
                    else:
                        data = base64.b64decode(msg.get("data_b64", ""))
                        client.stdin(data)
                elif t == "resize":
                    if client:
                        client.resize(msg.get("cols", cols), msg.get("rows", rows))
                elif t == "ping":
                    if client:
                        client.ping()
                    else:
                        send_to_ext({"type": "pong"})
                elif t == "close":
                    received_close = True
                    if client:
                        client.close()
                        client = None
                        send_to_ext({"type": "exit", "code": 0})
                else:
                    send_to_ext({"type": "error", "message": "unknown"})
            except Exception as e:
                send_to_ext({"type": "error", "message": str(e)})
    finally:
        log(f"Stopped native host {session}")


def main() -> None:
    """
    Dispatches to host or daemon mode based on argv.
    """
    if len(sys.argv) >= 2 and sys.argv[1] == "--session-daemon":
        if len(sys.argv) < 6:
            raise SystemExit(2)
        session_main(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
        return
    host_main()


if __name__ == "__main__":
    try:
        main()
    finally:
        log(f"{sys.argv} Exited")
