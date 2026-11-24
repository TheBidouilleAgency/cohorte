#!/usr/bin/env python3
"""Runs a command on a pseudo-terminal — for the tests of what only a person at a terminal may do.

    python3 scripts/ci/pty-run.py <command> [args…]

What arrives on our stdin is typed into the terminal (EOF on our stdin is a ^D at the start of a line), and the
command's output — stdout and stderr together, as a terminal shows them — comes out on our stdout. Exits with the
command's exit code. Echo is off, so the output holds only what the command wrote. POSIX only.
"""
import os
import pty
import select
import sys
import termios

ready_r, ready_w = os.pipe()  # nothing is typed before echo is off: it would echo into the output
pid, fd = pty.fork()
if pid == 0:
    os.close(ready_r)
    attrs = termios.tcgetattr(0)
    attrs[3] &= ~termios.ECHO
    termios.tcsetattr(0, termios.TCSANOW, attrs)
    os.write(ready_w, b"1")
    os.close(ready_w)
    os.execvp(sys.argv[1], sys.argv[1:])
os.close(ready_w)
os.read(ready_r, 1)
os.close(ready_r)

stdin_open = True
while True:
    try:
        ready, _, _ = select.select([fd] + ([0] if stdin_open else []), [], [])
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:  # EIO: the command closed the terminal
            break
        if not data:
            break
        os.write(1, data)
    if stdin_open and 0 in ready:
        data = os.read(0, 65536)
        if data:
            os.write(fd, data)
        else:
            stdin_open = False
            os.write(fd, b"\x04")
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
