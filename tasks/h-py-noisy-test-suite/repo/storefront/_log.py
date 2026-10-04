import logging
import sys

_handler = logging.StreamHandler(sys.stderr)
_handler.setFormatter(logging.Formatter("%(levelname)-7s %(name)s: %(message)s"))


def get_logger(name):
    logger = logging.getLogger(name)
    if _handler not in logger.handlers:
        logger.addHandler(_handler)
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    return logger
