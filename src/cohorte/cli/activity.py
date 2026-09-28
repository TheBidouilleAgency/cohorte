"""Visible CLI activity for blocking work outside the durable run journal."""

from __future__ import annotations

import sys
import threading
import time
from types import TracebackType


class Activity:
    """Report elapsed time only while a blocking operation is executing.

    The caller owns the context boundary: never include interactive prompts.
    JSON mode emits no progress so stdout remains one machine-readable object.
    """

    def __init__(self, label: str, *, enabled: bool = True, interval_seconds: float = 15) -> None:
        self.label = label
        self.enabled = enabled
        self.interval_seconds = interval_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._started = 0.0

    def __enter__(self) -> Activity:
        if self.enabled:
            self._started = time.monotonic()
            print(f"{self.label}…", file=sys.stderr, flush=True)
            self._thread = threading.Thread(target=self._heartbeat, daemon=True)
            self._thread.start()
        return self

    def __exit__(
        self,
        error_type: type[BaseException] | None,
        _error: BaseException | None,
        _traceback: TracebackType | None,
    ) -> None:
        if not self.enabled:
            return
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
        elapsed = int(time.monotonic() - self._started)
        outcome = "terminé" if error_type is None else "interrompu"
        print(f"{self.label} · {outcome} ({elapsed}s)", file=sys.stderr, flush=True)

    def _heartbeat(self) -> None:
        while not self._stop.wait(self.interval_seconds):
            elapsed = int(time.monotonic() - self._started)
            print(f"{self.label} · toujours en cours ({elapsed}s)", file=sys.stderr, flush=True)
