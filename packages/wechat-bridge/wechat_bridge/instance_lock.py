"""单实例文件锁。

同一台 Windows 机器只允许一个进程操作微信 UI。Windows 用 msvcrt 对锁文件
首字节加非阻塞独占锁；POSIX 用 fcntl.flock，便于在 Linux 上跑 Mock 自检。
进程崩溃时操作系统会自动释放锁，不需要手工删锁文件。
"""

from __future__ import annotations

import os
import time
from pathlib import Path


class InstanceAlreadyRunning(RuntimeError):
    """已经有另一个网桥进程持有锁。"""


class InstanceLock:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._fd: int | None = None
        self._locked = False

    def acquire(self) -> None:
        if self._locked:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(self.path), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            # 保证文件至少有 1 字节，msvcrt 才能锁住首字节。
            if os.fstat(fd).st_size == 0:
                os.write(fd, b"0")
                os.lseek(fd, 0, os.SEEK_SET)
            if os.name == "nt":
                import msvcrt

                try:
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                except OSError as exc:
                    raise InstanceAlreadyRunning(
                        f"已有网桥进程持有单实例锁：{self.path}（{exc}）"
                    ) from exc
            else:
                import fcntl

                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError as exc:
                    raise InstanceAlreadyRunning(
                        f"已有网桥进程持有单实例锁：{self.path}（{exc}）"
                    ) from exc
        except Exception:
            os.close(fd)
            raise

        # 写入 pid + 启动时间，排障时可确认锁被谁持有。
        try:
            os.lseek(fd, 0, os.SEEK_SET)
            os.ftruncate(fd, 0)
            stamp = time.strftime("%Y-%m-%d %H:%M:%S")
            os.write(fd, f"{os.getpid()} {stamp}\n".encode("utf-8"))
        except OSError:
            pass
        self._fd = fd
        self._locked = True

    def release(self) -> None:
        if not self._locked or self._fd is None:
            return
        try:
            if os.name == "nt":
                import msvcrt

                os.lseek(self._fd, 0, os.SEEK_SET)
                try:
                    msvcrt.locking(self._fd, msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass
            else:
                import fcntl

                try:
                    fcntl.flock(self._fd, fcntl.LOCK_UN)
                except OSError:
                    pass
        finally:
            try:
                os.close(self._fd)
            finally:
                self._fd = None
                self._locked = False

    def __enter__(self) -> "InstanceLock":
        self.acquire()
        return self

    def __exit__(self, *_exc) -> None:
        self.release()
