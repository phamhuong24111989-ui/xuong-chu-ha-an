"""App Text Overlay: chen chu tieu de + badge thuong hieu len anh. Chay tren may, khong can API.
Chay: python -X utf8 server.py  ->  http://localhost:8090"""
import base64, io, json, os, re, sys, time, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "scripts"))
import branded_overlay as bo  # noqa: E402

PORT = 8090
OUT = os.path.join(HERE, "ket-qua")


def render(photo_bytes, headline, badge, accent):
    bo.ACCENT = bo._doc_mau(accent or "#17C662")
    tmp_in = os.path.join(OUT, "_tmp_in.png")
    with open(tmp_in, "wb") as f:
        f.write(photo_bytes)
    name = time.strftime("%Y%m%d-%H%M%S") + ".jpg"
    out = os.path.join(OUT, name)
    bo.create_branded_image(tmp_in, headline, badge or "", out)
    os.remove(tmp_in)
    with open(out, "rb") as f:
        return name, f.read()


def suggest(text):
    """Rut 3 tieu de 6-9 tu tu bai viet (khong AI): uu tien cau co so lieu, cau mo dau, cau bai hoc."""
    sents = [s.strip(" \n\t-•") for s in re.split(r"(?<=[.!?\n])\s+", text) if len(s.strip()) > 12]
    def score(i, s):
        v = 0
        if re.search(r"\d", s): v += 3
        if i < 2: v += 2
        if re.search(r"(bài học|nhận ra|bí mật|sai lầm|không cần)", s, re.I): v += 2
        return v
    ranked = sorted(enumerate(sents), key=lambda p: -score(*p))[:3]
    out = []
    for _, s in ranked:
        words = s.rstrip(".!?").split()
        w = words[:9]
        # to cum co so (hoac 3 tu cuoi) lam diem nhan
        m = re.search(r"\S*\d\S*(?:\s+\S+){0,2}", " ".join(w))
        txt = " ".join(w)
        if m: txt = txt.replace(m.group(0), "**" + m.group(0) + "**", 1)
        else: txt = " ".join(w[:-3]) + " **" + " ".join(w[-3:]) + "**" if len(w) > 4 else "**" + txt + "**"
        out.append(txt.strip())
    return out


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)): body = json.dumps(body, ensure_ascii=False).encode("utf8")
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        if self.path.startswith("/ket-qua/"):
            p = os.path.join(OUT, os.path.basename(self.path))
            if os.path.exists(p):
                with open(p, "rb") as f: return self._send(200, f.read(), "image/jpeg")
        self._send(404, {"loi": "khong thay"})

    def do_POST(self):
        try:
            d = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            if self.path == "/api/render":
                raw = base64.b64decode(d["anh"].split(",", 1)[-1])
                name, data = render(raw, d.get("tieude", ""), d.get("badge", ""), d.get("mau"))
                return self._send(200, {"ten": name, "anh": "data:image/jpeg;base64," + base64.b64encode(data).decode()})
            if self.path == "/api/goi-y":
                return self._send(200, {"tieude": suggest(d.get("noidung", ""))})
        except Exception as e:
            return self._send(500, {"loi": str(e)})
        self._send(404, {"loi": "khong thay"})


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    print(f"App Text Overlay dang chay: http://localhost:{PORT}  (Ctrl+C de tat)")
    if "--khong-mo" not in sys.argv: webbrowser.open(f"http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
