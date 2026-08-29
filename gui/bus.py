import queue
import threading


class Bus:
    def __init__(self):
        self._subs = set()
        self._lock = threading.Lock()

    def subscribe(self) -> queue.Queue:
        q = queue.Queue()
        with self._lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            self._subs.discard(q)

    def publish(self, event: str, data=None) -> None:
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            q.put((event, data))
