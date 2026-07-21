import liveprobe
import pytest


def test_package_imports() -> None:
    assert liveprobe.__version__ == "0.1.1"
    assert callable(liveprobe.start)
    assert callable(liveprobe.stop)


def test_singleton_is_retained_while_deferred_shutdown_is_pending(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class DeferredAgent:
        running = False
        shutdown_pending = True
        stop_calls = 0

        def stop(self) -> None:
            self.stop_calls += 1

    agent = DeferredAgent()
    monkeypatch.setattr(liveprobe, "_singleton", agent)

    liveprobe.stop()

    assert agent.stop_calls == 1
    assert liveprobe._singleton is agent
    with pytest.raises(RuntimeError, match="still stopping"):
        liveprobe.start(service_id="service", broker_url="http://127.0.0.1")
