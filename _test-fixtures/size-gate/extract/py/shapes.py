import functools

square = lambda x: x * x


def plain(a):
    return a + 1


async def fetch(url):
    return url


@functools.lru_cache(maxsize=None)
@staticmethod
def decorated(n):
    return n


class Widget:
    def method(self):
        def helper():
            return 1

        return helper()

    @property
    def size(self):
        return 0

    async def load(self):
        return None


def outer():
    def inner():
        handler = lambda: None
        return handler

    class Local:
        def km(self):
            return 2

    return inner, Local


def sort_keys(items):
    return sorted(items, key=lambda v: v)
