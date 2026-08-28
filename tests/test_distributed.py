"""Redis 协调层不需真实 Redis 服务的单元测试。"""

from __future__ import annotations

from quant.distributed import RedisCoordinator


class FakeRedis:
    def __init__(self) -> None:
        self.counts = {}
        self.values = {}

    def eval(self, script, key_count, key, *args):  # noqa: ARG002
        if "INCR" in script:
            self.counts[key] = self.counts.get(key, 0) + 1
            return [self.counts[key], 10]
        token = args[0]
        if self.values.get(key) == token:
            self.values.pop(key, None)
            return 1
        return 0

    def set(self, key, value, *, nx, ex):  # noqa: ARG002
        if nx and key in self.values:
            return False
        self.values[key] = value
        return True


def _coordinator() -> RedisCoordinator:
    coordinator = object.__new__(RedisCoordinator)
    coordinator.client = FakeRedis()
    coordinator.prefix = "test"
    coordinator._disabled_until = 0.0
    return coordinator


def test_redis_rate_limit_is_shared_by_key():
    coordinator = _coordinator()
    assert coordinator.rate_limit("client-a", 1, 60) == (True, 10)
    assert coordinator.rate_limit("client-a", 1, 60) == (False, 10)
    assert coordinator.rate_limit("client-b", 1, 60) == (True, 10)


def test_distributed_lock_uses_owner_token_on_release():
    coordinator = _coordinator()
    acquired, token = coordinator.acquire_lock("optimize", 30)
    assert acquired and token
    assert coordinator.acquire_lock("optimize", 30) == (False, None)
    coordinator.release_lock("optimize", token)
    acquired_again, _ = coordinator.acquire_lock("optimize", 30)
    assert acquired_again
