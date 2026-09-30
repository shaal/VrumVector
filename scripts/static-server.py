#!/usr/bin/env python3
"""Static file server for local development and the browser tests.

It is `python3 -m http.server` with a deeper listen queue. The stock server
listens with a queue of 5 connections; a page load's burst of module requests
(the app loads dozens of ES modules and wasm files at once) overflows it on a
busy machine, and the browser gets ECONNRESET on some module file. The page
then never finishes loading, and a browser test times out before the code it
tests has run.

Usage (from the repo root, which it serves):
    python3 scripts/static-server.py [PORT] [--bind HOST]
"""
import argparse
import http.server


class Server(http.server.ThreadingHTTPServer):
    # The kernel caps this at its own limit (kern.ipc.somaxconn, 128 on
    # macOS). A browser opens about 6 connections per host at once, and this
    # server speaks HTTP/1.0 (a new connection per file), so that is far
    # above a page load's burst.
    request_queue_size = 256


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('port', nargs='?', type=int, default=8000)
    parser.add_argument('--bind', default='127.0.0.1')
    args = parser.parse_args()
    http.server.test(HandlerClass=http.server.SimpleHTTPRequestHandler,
                     ServerClass=Server, port=args.port, bind=args.bind)


if __name__ == '__main__':
    main()
