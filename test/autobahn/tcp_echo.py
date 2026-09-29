"""Length-agnostic raw TCP echo peer for exercising the real bridge relay."""

import socketserver


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        while True:
            chunk = self.request.recv(16 * 1024)
            if not chunk:
                return
            self.request.sendall(chunk)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("0.0.0.0", 9010), Handler) as server:
        server.serve_forever(poll_interval=0.25)
