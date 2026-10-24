#!/usr/bin/env python3
"""Test-only /bin/sh PTY peer. JSON stdin {input:text}; JSON stdout {data:text}.

Each PTY byte is independently UTF-8 decoded with replacement, reproducing
upstream chunk-toString loss. Exec's ASCII base64 wire must survive this.
No platform/CAS/network or user SSH files are accessed.
"""
import errno
import json
import os
import pty
import select
import signal
import sys

pid, master = pty.fork()
if pid == 0:
    os.execl('/bin/sh', 'sh')

def terminate(_signal, _frame):
    raise SystemExit(0)

signal.signal(signal.SIGTERM, terminate)

pending = b''
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin.fileno()], [], [], 10)
        if not ready:
            raise TimeoutError('PTY fixture idle timeout')
        if sys.stdin.fileno() in ready:
            chunk = os.read(sys.stdin.fileno(), 65536)
            if not chunk:
                break
            pending += chunk
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                message = json.loads(line)
                encoded = message['input'].encode('utf-8')
                while encoded:
                    written = os.write(master, encoded)
                    encoded = encoded[written:]
        if master in ready:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
            if not chunk:
                break
            for byte in chunk:
                text = bytes([byte]).decode('utf-8', errors='replace')
                sys.stdout.write(json.dumps({'data': text}) + '\n')
            sys.stdout.flush()
finally:
    os.close(master)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
