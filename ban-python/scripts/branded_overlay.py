#!/usr/bin/env python3
"""
Branded Photo Overlay - chen chu tieu de + badge thuong hieu len anh
White headline text (no stroke) + neon yellow-green accent keyword(s) + white pill badge (bottom-right).

CLI:
    python3 branded_overlay.py --photo IN.jpg --headline "Ban khong can code de **xay AI agent**" \
        --output OUT.jpg [--badge "shopcuaban.com"] [--accent "#FF5C8A"]

Python:
    from branded_overlay import create_branded_image
    create_branded_image("in.jpg", "Cau **tu khoa**", "shopcuaban.com", "out.jpg")
"""
import argparse
import os
import re
from PIL import Image, ImageDraw, ImageFont

# ---- BRAND SPEC (co dinh, khong doi giua cac lan dung) ----
CANVAS_SIZE = (1080, 1350)            # 4:5, chuan Facebook/Instagram feed
NEON = (216, 255, 61)                 # mau nhan MAC DINH; doi bang --accent hoac sua o day
WHITE = (255, 255, 255)
BADGE_BG_COLOR = WHITE                # badge nen trang
BADGE_TEXT_COLOR = (15, 15, 15)       # chu badge den
DEFAULT_BADGE_TEXT = ""               # KHONG mac dinh: badge la thuong hieu cua NGUOI DUNG

ACCENT = NEON                         # mau nhan dang dung; main() ghi de bang --accent

HEADLINE_FONT_SIZE = 72
HEADLINE_MIN_FONT_SIZE = 42           # tu dong thu nho de KHONG bao gio qua 2 dong
BADGE_FONT_SIZE = 28
BADGE_MIN_FONT_SIZE = 18
MARGIN = 64
LINE_SPACING = 18
MAX_LINES = 2                         # gioi han cung: toi da 2 dong, khong thua dong le


def _find_font():
    """Uu tien font bundle theo skill (chay duoc moi may). Fallback ve font he thong neu thieu."""
    here = os.path.dirname(os.path.abspath(__file__))
    bundled = os.path.join(here, "..", "assets", "fonts", "Lato-Black.ttf")
    if os.path.exists(bundled):
        return bundled
    fallback_candidates = [
        "/usr/share/fonts/truetype/lato/Lato-Black.ttf",
        "/usr/share/fonts/truetype/lato/Lato-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "C:\\Windows\\Fonts\\arialbd.ttf",
    ]
    for c in fallback_candidates:
        if os.path.exists(c):
            return c
    raise FileNotFoundError(
        "Khong tim thay font Bold co dau tieng Viet. Hay dat 1 file .ttf vao assets/fonts/Lato-Black.ttf"
    )


FONT_BOLD = _find_font()


def _doc_mau(hex_str):
    """Doi "#D8FF3D" hoac "D8FF3D" thanh (216, 255, 61)."""
    h = hex_str.strip().lstrip("#")
    if len(h) != 6:
        raise ValueError("Ma mau phai co 6 ky tu hex, vi du #D8FF3D — nhan duoc: " + hex_str)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _fit_cover(img: Image.Image, size):
    """Resize+crop de lap day canvas (giong object-fit: cover)."""
    target_w, target_h = size
    src_w, src_h = img.size
    scale = max(target_w / src_w, target_h / src_h)
    new_w, new_h = int(src_w * scale), int(src_h * scale)
    img = img.resize((new_w, new_h), Image.LANCZOS)
    left = (new_w - target_w) // 2
    top = (new_h - target_h) // 2
    return img.crop((left, top, left + target_w, top + target_h))


def _add_bottom_gradient(img: Image.Image, height_ratio=0.62, max_alpha=225):
    """Gradient toi dan o day anh - khong dung vien chu nen can gradient du manh de chu trang luon doc ro."""
    w, h = img.size
    grad_h = int(h * height_ratio)
    gradient = Image.new("L", (1, grad_h), color=0)
    for y in range(grad_h):
        alpha = int(max_alpha * (y / grad_h) ** 1.5)
        gradient.putpixel((0, y), alpha)
    gradient = gradient.resize((w, grad_h))
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    black = Image.new("RGBA", (w, grad_h), (0, 0, 0, 255))
    overlay.paste(black, (0, h - grad_h), gradient)
    return Image.alpha_composite(img.convert("RGBA"), overlay)


def _parse_markup(headline_markup):
    """'**cum tu**' -> danh sach (word, is_accent), ho tro highlight nhieu tu lien tiep."""
    tokens = []
    parts = re.split(r"\*\*(.+?)\*\*", headline_markup)
    for i, part in enumerate(parts):
        if not part:
            continue
        is_accent = (i % 2 == 1)
        for word in part.split():
            tokens.append((word, is_accent))
    return tokens


def _line_width(draw, tokens, font):
    text = " ".join(w for w, _ in tokens)
    return draw.textlength(text, font=font)


def _best_fit_lines(draw, tokens, max_width):
    """
    Tim font-size lon nhat + cach xuong dong CAN DOI sao cho:
    - toi da MAX_LINES dong
    - khong dong nao vuot max_width
    - neu can 2 dong, chon diem ngat lam 2 dong gan bang nhau nhat (tranh dong 2 mo coi 1 chu)
    """
    for size in range(HEADLINE_FONT_SIZE, HEADLINE_MIN_FONT_SIZE - 1, -2):
        font = ImageFont.truetype(FONT_BOLD, size)
        full_w = _line_width(draw, tokens, font)
        if full_w <= max_width:
            return font, [tokens]

        n = len(tokens)
        best = None
        for split in range(1, n):
            line1, line2 = tokens[:split], tokens[split:]
            w1 = _line_width(draw, line1, font)
            w2 = _line_width(draw, line2, font)
            if w1 <= max_width and w2 <= max_width:
                score = max(w1, w2)
                if best is None or score < best[0]:
                    best = (score, [line1, line2])
        if best:
            return font, best[1]

    font = ImageFont.truetype(FONT_BOLD, HEADLINE_MIN_FONT_SIZE)
    lines, current = [], []
    for word, accent in tokens:
        trial = current + [(word, accent)]
        if _line_width(draw, trial, font) > max_width and current:
            lines.append(current)
            current = [(word, accent)]
        else:
            current = trial
    if current:
        lines.append(current)
    return font, lines


def _draw_line_centered(draw, line, font, canvas_w, y):
    total_w = _line_width(draw, line, font)
    x = (canvas_w - total_w) / 2
    for word, accent in line:
        color = ACCENT if accent else WHITE
        draw.text((x, y), word, font=font, fill=color)
        x += draw.textlength(word + " ", font=font)


def _badge_font_and_size(draw, badge_text, max_width):
    for size in range(BADGE_FONT_SIZE, BADGE_MIN_FONT_SIZE - 1, -2):
        font = ImageFont.truetype(FONT_BOLD, size)
        w = draw.textlength(badge_text, font=font) + 44
        if w <= max_width:
            return font, w
    font = ImageFont.truetype(FONT_BOLD, BADGE_MIN_FONT_SIZE)
    return font, draw.textlength(badge_text, font=font) + 44


def create_branded_image(photo_path, headline_markup, badge_text, output_path):
    """
    headline_markup: text voi cum tu can highlight neon boc trong **...**
       vd: "3 AI agent chay 24/7 ton **$67/thang**"
    Nen viet headline NGAN GON, du y (1 cau, <= ~8-9 tu) de khop dung 1-2 dong dep.
    """
    base = Image.open(photo_path).convert("RGB")
    base = _fit_cover(base, CANVAS_SIZE)
    base = _add_bottom_gradient(base)
    draw = ImageDraw.Draw(base)

    tokens = _parse_markup(headline_markup)
    max_text_width = CANVAS_SIZE[0] - 2 * MARGIN

    font, lines = _best_fit_lines(draw, tokens, max_text_width)

    line_h = font.getbbox("Ag")[3]
    block_h = len(lines) * line_h + (len(lines) - 1) * LINE_SPACING

    # Badge de trong thi KHONG ve vien thuoc rong, va tra lai khoang trong day
    # cho chu — khach chua co thuong hieu van dung duoc skill.
    co_badge = bool(badge_text and badge_text.strip())
    badge_max_width = CANVAS_SIZE[0] - 2 * MARGIN
    if co_badge:
        badge_font, badge_w = _badge_font_and_size(draw, badge_text, badge_max_width)
        badge_h = badge_font.size + 26
    else:
        badge_font, badge_w, badge_h = None, 0, 0

    bottom_reserved = MARGIN + badge_h + (34 if co_badge else 0)
    y = CANVAS_SIZE[1] - bottom_reserved - block_h
    for line in lines:
        _draw_line_centered(draw, line, font, CANVAS_SIZE[0], y)
        y += line_h + LINE_SPACING

    if co_badge:
        bx2 = CANVAS_SIZE[0] - MARGIN
        by2 = CANVAS_SIZE[1] - MARGIN
        bx1 = bx2 - badge_w
        by1 = by2 - badge_h
        draw.rounded_rectangle((bx1, by1, bx2, by2), radius=badge_h // 2, fill=BADGE_BG_COLOR)
        tw = draw.textlength(badge_text, font=badge_font)
        tx = bx1 + (badge_w - tw) / 2
        ty = by1 + (badge_h - badge_font.size) / 2 - badge_font.size * 0.12
        draw.text((tx, ty), badge_text, font=badge_font, fill=BADGE_TEXT_COLOR)

    base.convert("RGB").save(output_path, quality=95)
    return output_path


def main():
    parser = argparse.ArgumentParser(description="Tao anh 4:5 co tieu de + badge thuong hieu")
    parser.add_argument("--photo", required=True, help="Duong dan anh goc")
    parser.add_argument("--headline", required=True, help="Headline, boc tu khoa can highlight trong **...**")
    parser.add_argument("--output", required=True, help="Duong dan file anh output")
    parser.add_argument("--badge", default=DEFAULT_BADGE_TEXT,
                        help="Chu tren badge goc duoi phai — dat thuong hieu cua NGUOI DUNG (vd shopcuaban.com). De trong thi khong ve badge.")
    parser.add_argument("--accent", default=None,
                        help="Ma mau hex to tu khoa, vd #D8FF3D. Bo qua thi dung mau mac dinh.")
    args = parser.parse_args()
    if args.accent:
        global ACCENT
        ACCENT = _doc_mau(args.accent)
    out = create_branded_image(args.photo, args.headline, args.badge, args.output)
    print(f"Da tao: {out}")


if __name__ == "__main__":
    main()
