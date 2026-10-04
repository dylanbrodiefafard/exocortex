"""Generate a synthetic production log for exercising the analyzer.

The output mixes every format our services emit (see README.md). It is fully
determined by --seed and --entries, so reports are reproducible.

    python3 tools/gen_logs.py --seed 1 > logs/app.log
"""

import argparse
import json
import random
import sys
from datetime import datetime, timedelta, timezone

START = datetime(2026, 3, 14, 0, 0, 0, tzinfo=timezone.utc)

SERVICES = ["auth", "billing", "orders", "search", "gateway", "inventory", "notify"]
LEVEL_WEIGHTS = [("TRACE", 2), ("DEBUG", 18), ("INFO", 60), ("WARN", 11), ("ERROR", 8), ("FATAL", 1)]
CODES = ["E1001", "E1002", "E1203", "E2001", "E2002", "E3100", "E3101", "E4040", "E5000", "E5003"]
USERS = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi", "ivan", "judy"]
ODD_USERS = ["o'brien", "d'angelo", "o'neil", "l'oreal-svc"]
MESSAGES = {
    "TRACE": ["enter handler", "exit handler", "cache probe"],
    "DEBUG": ["cache miss", "cache hit", "query planned", "pool stats", "retry scheduled"],
    "INFO": ["request served", "user login ok", "order created", "index refreshed", "job finished",
             "health check ok", "config reloaded"],
    "WARN": ["slow query", "retrying request", "pool nearly exhausted", "deprecated endpoint used"],
    "ERROR": ["request failed", "charge declined", "upstream timeout", "unhandled exception",
              "db write failed"],
    "FATAL": ["worker crashed", "out of memory", "cannot bind port"],
}
EXCEPTIONS = [
    "java.lang.IllegalStateException", "java.lang.NullPointerException",
    "java.util.concurrent.TimeoutException", "com.acme.billing.ChargeDeclinedException",
    "com.acme.orders.OrderNotFoundException", "java.lang.IllegalArgumentException",
]
CAUSES = [
    "java.io.IOException", "java.net.SocketTimeoutException", "java.sql.SQLTransientConnectionException",
    "com.acme.db.DeadlockException", "java.net.ConnectException",
]
FRAMES = [
    "com.acme.{svc}.Handler.handle(Handler.java:{n})",
    "com.acme.{svc}.Service.process(Service.java:{n})",
    "com.acme.common.Retry.run(Retry.java:{n})",
    "org.eclipse.jetty.server.HttpChannel.handle(HttpChannel.java:{n})",
    "java.base/java.util.concurrent.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:{n})",
    "java.base/java.lang.Thread.run(Thread.java:{n})",
]
GARBAGE = [
    "", "-- MARK --", "Connection reset by peer", "<<binary payload elided>>",
    "#######", "=== log rotated ===",
]


def fmt_ts(t, offset_minutes=0):
    local = t.astimezone(timezone(timedelta(minutes=offset_minutes)))
    stamp = local.strftime("%Y-%m-%dT%H:%M:%S") + ".%03d" % (local.microsecond // 1000)
    if offset_minutes == 0:
        return stamp + "Z"
    sign = "+" if offset_minutes > 0 else "-"
    h, m = divmod(abs(offset_minutes), 60)
    return "%s%s%02d:%02d" % (stamp, sign, h, m)


def kv_quote(value):
    if value and all(c not in value for c in ' "=\\'):
        return value
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


class Generator:
    def __init__(self, seed, entries):
        self.rng = random.Random(seed)
        self.entries = entries
        self.out = []

    def level(self):
        r = self.rng.uniform(0, sum(w for _, w in LEVEL_WEIGHTS))
        for name, weight in LEVEL_WEIGHTS:
            r -= weight
            if r <= 0:
                return name
        return "INFO"

    def code_for(self, level):
        if level in ("ERROR", "FATAL") and self.rng.random() < 0.8:
            return self.rng.choice(CODES)
        if level == "WARN" and self.rng.random() < 0.2:
            return self.rng.choice(CODES)
        return None

    def trace(self, svc, frac):
        rng = self.rng
        indent = "    " if svc == "search" and frac > 0.6 else "\t"
        lines = ["%s: %s" % (rng.choice(EXCEPTIONS), rng.choice(["boom", "unexpected state", "id=42"]))]
        for _ in range(rng.randint(3, 9)):
            lines.append(indent + "at " + rng.choice(FRAMES).format(svc=svc, n=rng.randint(10, 900)))
        if frac > 0.5 and rng.random() < 0.35:
            for _ in range(rng.randint(1, 2)):
                lines.append("Caused by: %s: %s" % (rng.choice(CAUSES), rng.choice(["timed out", "refused", "eof"])))
                for _ in range(rng.randint(1, 4)):
                    lines.append(indent + "at " + rng.choice(FRAMES).format(svc=svc, n=rng.randint(10, 900)))
                lines.append(indent + "... %d more" % rng.randint(3, 40))
        return lines

    def text_entry(self, t, frac):
        rng = self.rng
        level = self.level()
        svc = rng.choice(SERVICES)
        offset = 0
        if frac > 0.78 and rng.random() < 0.04:
            svc, offset = "edge-us", -420
        msg = rng.choice(MESSAGES[level])
        if rng.random() < 0.5:
            msg += " user=" + rng.choice(USERS)
        code = self.code_for(level)
        if code:
            msg += " code=" + code
        msg += " latency_ms=%d" % rng.randint(1, 3000)
        lines = ["%s %-5s [%s] %s" % (fmt_ts(t, offset), level, svc, msg)]
        if level in ("ERROR", "FATAL") and rng.random() < 0.3:
            lines.extend(self.trace(svc, frac))
        return lines

    def kv_entry(self, t, frac):
        rng = self.rng
        level = self.level()
        svc = rng.choice(SERVICES)
        raw_level = level.lower()
        if 0.55 < frac < 0.65 and rng.random() < 0.5:
            svc = "legacy-batch"
            raw_level = {
                "WARN": rng.choice(["warning", "WARNING", "Warning"]),
                "FATAL": rng.choice(["critical", "CRITICAL"]),
                "ERROR": rng.choice(["err", "ERR", "Error"]),
            }.get(level, level.lower())
        fields = [("ts", fmt_ts(t)), ("level", raw_level), ("service", svc)]
        msg = rng.choice(MESSAGES[level])
        if rng.random() < 0.15:
            msg += ' (filter="%s", limit=%d)' % (rng.choice(USERS), rng.randint(1, 50))
        fields.append(("msg", msg))
        user = rng.choice(USERS)
        if frac > 0.7 and rng.random() < 0.02:
            user = rng.choice(ODD_USERS)
        fields.append(("user", user))
        code = self.code_for(level)
        if code:
            fields.append(("code", code))
        fields.append(("dur", "%dms" % rng.randint(1, 900)))
        return [" ".join("%s=%s" % (k, kv_quote(v) if k != "user" else v) for k, v in fields)]

    def json_entry(self, t, frac):
        rng = self.rng
        level = self.level()
        svc = rng.choice(SERVICES)
        offset = 0
        if frac > 0.85 and rng.random() < 0.06:
            svc, offset = "edge-apac", 330
        obj = {"ts": fmt_ts(t, offset), "level": level, "service": svc, "msg": rng.choice(MESSAGES[level])}
        code = self.code_for(level)
        if code:
            if frac > 0.62 and rng.random() < 0.4:
                obj["service"] = "payments-v2"
                obj["error"] = {"code": code, "type": rng.choice(["Timeout", "Declined", "Internal"])}
            else:
                obj["code"] = code
        obj["req"] = "%08x" % rng.getrandbits(32)
        return [json.dumps(obj)]

    def garbage(self, t, frac):
        rng = self.rng
        roll = rng.random()
        if roll < 0.15:
            return ['{"ts": "%s", "level": "INFO", "serv' % fmt_ts(t)]
        if roll < 0.2:
            return ["\t"]
        return [rng.choice(GARBAGE)]

    def run(self):
        rng = self.rng
        t = START
        binary_at = {int(self.entries * 0.42), int(self.entries * 0.42) + 1, int(self.entries * 0.91)}
        lines = []
        for i in range(self.entries):
            frac = i / self.entries
            t += timedelta(milliseconds=rng.randint(0, 900))
            roll = rng.random()
            if roll < 0.68:
                lines.extend(self.text_entry(t, frac))
            elif roll < 0.84:
                lines.extend(self.kv_entry(t, frac))
            elif roll < 0.99:
                lines.extend(self.json_entry(t, frac))
            else:
                lines.extend(self.garbage(t, frac))
            if i in binary_at:
                lines.append(None)
        out = sys.stdout.buffer
        for line in lines:
            if line is None:
                out.write(b"\x00\x17\xff\xfepayload \xc3\x28\xa0\xa1 dump\n")
            else:
                out.write(line.encode("utf-8") + b"\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--entries", type=int, default=30000)
    args = parser.parse_args()
    Generator(args.seed, args.entries).run()


if __name__ == "__main__":
    main()
