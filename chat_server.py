from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import json
import mimetypes
import os
import queue
import random
import re
import string
import threading
from datetime import datetime, timezone


ROOT = Path(__file__).parent
PORT = int(os.environ.get("PORT", "3000"))
HOST = os.environ.get("HOST", "0.0.0.0")
rooms = {}
lock = threading.Lock()


def clean_room(value):
    return re.sub(r"[^A-Z0-9-]", "", str(value or "").strip().upper())[:24]


def clean_name(value):
    name = str(value or "Someone").strip()[:28]
    return name or "Someone"


def clean_text(value):
    return str(value or "").strip()[:7000000]


def get_room(room_id):
    with lock:
        return rooms.setdefault(
            room_id,
            {"clients": set(), "client_names": {}, "messages": [], "typing": set()},
        )


def broadcast(room_id, event, data):
    room = get_room(room_id)
    stale = []
    with lock:
        clients = list(room["clients"])
    for client in clients:
        try:
            client.put((event, data), timeout=0.1)
        except Exception:
            stale.append(client)
    if stale:
        with lock:
            for client in stale:
                room["clients"].discard(client)
                room["client_names"].pop(client, None)


def mark_messages(room, viewer):
    changed = []
    for message in room["messages"]:
        if message["sender"] == viewer:
            continue
        if viewer not in message["deliveredTo"]:
            message["deliveredTo"].append(viewer)
        if viewer not in message["seenBy"]:
            message["seenBy"].append(viewer)
            changed.append(message)
    return changed


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        return

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 7500000:
            raise ValueError("Payload too large")
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/events":
            params = parse_qs(parsed.query)
            room_id = clean_room(params.get("room", [""])[0])
            name = clean_name(params.get("name", ["Someone"])[0])
            if not room_id:
                self.send_json(400, {"error": "Room code required"})
                return

            room = get_room(room_id)
            client = queue.Queue()
            with lock:
                room["clients"].add(client)
                room["client_names"][client] = name
                count = len(room["clients"])
                names = sorted(set(room["client_names"].values()))
                changed = mark_messages(room, name)
                messages = room["messages"][-80:]

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            self.write_event("ready", {"roomId": room_id, "messages": messages})
            broadcast(room_id, "presence", {"count": count, "names": names, "name": name, "joined": True})
            if changed:
                broadcast(room_id, "receipts", {"messages": changed})

            try:
                while True:
                    event, data = client.get(timeout=25)
                    self.write_event(event, data)
            except Exception:
                with lock:
                    room["clients"].discard(client)
                    room["client_names"].pop(client, None)
                    room["typing"].discard(name)
                    count = len(room["clients"])
                    names = sorted(set(room["client_names"].values()))
                broadcast(room_id, "presence", {"count": count, "names": names, "name": name, "joined": False})
                broadcast(room_id, "typing", {"names": sorted(room["typing"])})
            return

        self.serve_static(parsed.path)

    def write_event(self, event, data):
        payload = f"event: {event}\ndata: {json.dumps(data)}\n\n".encode("utf-8")
        self.wfile.write(payload)
        self.wfile.flush()

    def serve_static(self, path):
        filename = "index.html" if path == "/" else path.lstrip("/")
        target = (ROOT / filename).resolve()
        if ROOT.resolve() not in target.parents and target != ROOT.resolve():
            self.send_error(403)
            return
        if not target.exists() or not target.is_file():
            self.send_error(404)
            return

        body = target.read_bytes()
        content_type = mimetypes.guess_type(target.name)[0] or "text/plain"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            body = self.read_json()
        except Exception as error:
            self.send_json(400, {"error": str(error)})
            return

        if parsed.path == "/message":
            room_id = clean_room(body.get("room"))
            sender = clean_name(body.get("sender"))
            text = clean_text(body.get("text"))
            if not room_id or not text:
                self.send_json(400, {"error": "Room and message required"})
                return

            message = {
                "id": f"{int(datetime.now().timestamp() * 1000)}-{''.join(random.choices(string.ascii_lowercase, k=6))}",
                "sender": sender,
                "text": text,
                "sentAt": datetime.now(timezone.utc).isoformat(),
                "editedAt": None,
                "deleted": False,
                "deliveredTo": [],
                "seenBy": [],
            }
            room = get_room(room_id)
            with lock:
                online_names = set(room["client_names"].values())
                message["deliveredTo"] = sorted(name for name in online_names if name != sender)
                room["messages"].append(message)
                room["messages"] = room["messages"][-120:]
                room["typing"].discard(sender)
            broadcast(room_id, "message", message)
            broadcast(room_id, "typing", {"names": sorted(room["typing"])})
            self.send_json(201, {"ok": True, "message": message})
            return

        if parsed.path == "/edit":
            room_id = clean_room(body.get("room"))
            sender = clean_name(body.get("sender"))
            message_id = str(body.get("id") or "")
            text = clean_text(body.get("text"))
            if not room_id or not message_id or not text:
                self.send_json(400, {"error": "Room, message id, and text required"})
                return
            room = get_room(room_id)
            updated = None
            with lock:
                for message in room["messages"]:
                    if message["id"] == message_id and message["sender"] == sender and not message.get("deleted"):
                        message["text"] = text
                        message["editedAt"] = datetime.now(timezone.utc).isoformat()
                        updated = message
                        break
            if not updated:
                self.send_json(404, {"error": "Message not found"})
                return
            broadcast(room_id, "message_edit", updated)
            self.send_json(200, {"ok": True, "message": updated})
            return

        if parsed.path == "/delete":
            room_id = clean_room(body.get("room"))
            sender = clean_name(body.get("sender"))
            message_id = str(body.get("id") or "")
            if not room_id or not message_id:
                self.send_json(400, {"error": "Room and message id required"})
                return
            room = get_room(room_id)
            updated = None
            with lock:
                for message in room["messages"]:
                    if message["id"] == message_id and message["sender"] == sender and not message.get("deleted"):
                        message["text"] = ""
                        message["deleted"] = True
                        message["editedAt"] = datetime.now(timezone.utc).isoformat()
                        updated = message
                        break
            if not updated:
                self.send_json(404, {"error": "Message not found"})
                return
            broadcast(room_id, "message_delete", updated)
            self.send_json(200, {"ok": True, "message": updated})
            return

        if parsed.path == "/seen":
            room_id = clean_room(body.get("room"))
            viewer = clean_name(body.get("sender"))
            if not room_id:
                self.send_json(400, {"error": "Room required"})
                return
            room = get_room(room_id)
            with lock:
                changed = mark_messages(room, viewer)
            if changed:
                broadcast(room_id, "receipts", {"messages": changed})
            self.send_json(200, {"ok": True})
            return

        if parsed.path == "/typing":
            room_id = clean_room(body.get("room"))
            sender = clean_name(body.get("sender"))
            if not room_id:
                self.send_json(400, {"error": "Room required"})
                return
            room = get_room(room_id)
            with lock:
                if body.get("typing"):
                    room["typing"].add(sender)
                else:
                    room["typing"].discard(sender)
                names = sorted(room["typing"])
            broadcast(room_id, "typing", {"names": names})
            self.send_json(200, {"ok": True})
            return

        self.send_json(404, {"error": "Not found"})


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Couple Chat running at http://127.0.0.1:{PORT}")
    server.serve_forever()
