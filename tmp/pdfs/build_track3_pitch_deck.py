from pathlib import Path
from xml.sax.saxutils import escape
import sys

from reportlab.lib import colors
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph

OUT = Path(sys.argv[1])
SCREENSHOT = Path(sys.argv[2])
W, H = 960, 540
BASE = "https://savanna-assistant-demo.onrender.com"

FOREST = HexColor("#163D2E")
DEEP = HexColor("#0B261D")
GREEN = HexColor("#2D8B57")
MINT = HexColor("#DDEFE3")
CREAM = HexColor("#F6F7F2")
PAPER = colors.white
INK = HexColor("#22342A")
MUTED = HexColor("#5B6D61")
AMBER = HexColor("#F2B46D")
LINE = HexColor("#D7E3DA")
PALE = HexColor("#EAF4ED")

styles = {
    "body": ParagraphStyle("body", fontName="Helvetica", fontSize=13, leading=18, textColor=INK, spaceAfter=0),
    "small": ParagraphStyle("small", fontName="Helvetica", fontSize=10.5, leading=14, textColor=MUTED, spaceAfter=0),
    "white": ParagraphStyle("white", fontName="Helvetica", fontSize=13, leading=18, textColor=PAPER, spaceAfter=0),
    "smallwhite": ParagraphStyle("smallwhite", fontName="Helvetica", fontSize=10.5, leading=14, textColor=HexColor("#D7E8DC"), spaceAfter=0),
    "card": ParagraphStyle("card", fontName="Helvetica", fontSize=11.5, leading=16, textColor=INK, spaceAfter=0),
    "link": ParagraphStyle("link", fontName="Helvetica", fontSize=8.6, leading=12, textColor=GREEN, spaceAfter=0),
}

def rr(c, x, y, w, h, fill, stroke=None, radius=14, sw=1):
    c.setFillColor(fill)
    c.setStrokeColor(stroke or fill)
    c.setLineWidth(sw)
    c.roundRect(x, y, w, h, radius, fill=1, stroke=1 if stroke else 0)

def text(c, value, x, y, size=12, color=INK, font="Helvetica"):
    c.setFillColor(color)
    c.setFont(font, size)
    c.drawString(x, y, value)

def para(c, value, x, top, width, style="body", link=None):
    p = Paragraph(value, styles[style])
    _, height = p.wrap(width, H)
    p.drawOn(c, x, top - height)
    if link:
        c.linkURL(link, (x, top - height, x + width, top), relative=0, thickness=0)
    return height

def header(c, num, section, title, dark=False):
    bg = DEEP if dark else CREAM
    fg = HexColor("#D6E7DA") if dark else GREEN
    c.setFillColor(bg)
    c.rect(0, 0, W, H, fill=1, stroke=0)
    text(c, "TRACK 3  /  MULTILINGUAL ASSISTANT AND LIVE HELP", 48, 503, 9, fg, "Helvetica-Bold")
    text(c, section.upper(), 48, 475, 9, AMBER, "Helvetica-Bold")
    text(c, title, 48, 439, 25, PAPER if dark else FOREST, "Helvetica-Bold")
    c.setStrokeColor(GREEN)
    c.setLineWidth(3)
    c.line(48, 424, 93, 424)
    c.setFillColor(HexColor("#86A594") if dark else MUTED)
    c.setFont("Helvetica", 8)
    c.drawString(48, 22, "db-assistant | Savanna learning demo")
    c.drawRightString(W - 48, 22, f"{num} / 6")

def arrow(c, x1, y, x2, color=GREEN):
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(2)
    c.line(x1, y, x2 - 9, y)
    c.line(x2 - 9, y, x2 - 16, y + 5)
    c.line(x2 - 9, y, x2 - 16, y - 5)

def card(c, x, y, w, h, title, body, num=None):
    rr(c, x, y, w, h, PAPER, LINE, 14)
    if num is not None:
        c.setFillColor(MINT)
        c.circle(x + 25, y + h - 28, 14, fill=1, stroke=0)
        c.setFillColor(FOREST)
        c.setFont("Helvetica-Bold", 11)
        c.drawCentredString(x + 25, y + h - 32, str(num))
        title_x = x + 48
    else:
        title_x = x + 18
    text(c, title, title_x, y + h - 34, 13, FOREST, "Helvetica-Bold")
    para(c, body, x + 18, y + h - 50, w - 36, "card")

c = canvas.Canvas(str(OUT), pagesize=(W, H), pageCompression=1)
c.setTitle("Savanna db-assistant - Track 3 Pitch Deck")
c.setAuthor("Track 3 project team")
c.setSubject("Multilingual assistant and live help for Savanna learning pages")

# Slide 1 - cover
c.setFillColor(DEEP)
c.rect(0, 0, W, H, fill=1, stroke=0)
c.setFillColor(GREEN)
c.circle(860, 485, 155, fill=1, stroke=0)
c.setFillColor(HexColor("#1B4A37"))
c.circle(850, 500, 120, fill=1, stroke=0)
text(c, "ALX DIGITAL BRIDGE  |  ACCESSIBILITY HACKATHON 2026", 52, 494, 9, HexColor("#D1E5D7"), "Helvetica-Bold")
text(c, "TRACK 3", 52, 455, 11, AMBER, "Helvetica-Bold")
text(c, "Learning support,", 52, 399, 32, PAPER, "Helvetica-Bold")
text(c, "right where learning happens.", 52, 359, 27, PAPER, "Helvetica-Bold")
para(c, "A multilingual assistant that answers from course content, points to its source, and connects learners with a tutor when more help is needed.", 54, 322, 390, "white")
rr(c, 52, 202, 397, 54, HexColor("#204B38"), HexColor("#4C755B"), 12)
text(c, "Answer  >  evidence  >  human help", 72, 222, 16, PAPER, "Helvetica-Bold")
para(c, "A lightweight web component for three Savanna learner pages and a blank-host demo.", 54, 177, 365, "smallwhite")
text(c, "LIVE DEMO", 54, 112, 9, AMBER, "Helvetica-Bold")
text(c, BASE.replace("https://", ""), 54, 88, 12, PAPER, "Helvetica-Bold")
c.linkURL(BASE, (52, 80, 430, 108), relative=0, thickness=0)
text(c, "Track 3: Multilingual assistant and live help", 54, 43, 9, HexColor("#B8CDC0"))

# Screenshot frame and supplied product image
rr(c, 488, 90, 424, 340, HexColor("#F9FBF8"), HexColor("#B8D4C2"), 18, 1.2)
if SCREENSHOT.exists():
    img = ImageReader(str(SCREENSHOT))
    iw, ih = img.getSize()
    maxw, maxh = 398, 282
    scale = min(maxw / iw, maxh / ih)
    dw, dh = iw * scale, ih * scale
    c.drawImage(img, 500 + (maxw - dw) / 2, 126 + (maxh - dh) / 2, width=dw, height=dh, preserveAspectRatio=True, mask="auto")
text(c, "User-provided Render screenshot: course lesson with Amharic assistant", 505, 106, 8.6, MUTED)
c.showPage()

# Slide 2 - problem
header(c, 2, "The problem", "Learning content needs a clear path to help.")
para(c, "Track 3 asks teams to make course support easier to reach, useful without paid AI, and connected to a real person when self-service is not enough.", 50, 397, 820, "body")
problem_cards = [
    ("Answers are hard to verify", "A useful course answer should show which lesson section supports it, so learners can open the source and check the context."),
    ("Different needs, one page", "Language, keyboard and voice needs vary. Help should be part of the page and work across different host experiences."),
    ("A dead end is not support", "When the course cannot answer, the learner needs a clear, consented handoff to a tutor and a place to receive a reply."),
]
xs = [50, 337, 624]
for i, ((title, body), x) in enumerate(zip(problem_cards, xs), 1):
    card(c, x, 217, 267, 135, title, body, i)
rr(c, 50, 93, 840, 77, FOREST, radius=14)
text(c, "PROBLEM STATEMENT", 70, 142, 9, AMBER, "Helvetica-Bold")
para(c, "Learners can lose time searching course pages for a trustworthy answer and may not know what to do when the content is not enough.", 70, 128, 790, "white")
text(c, "This is the project problem framing from the Track 3 brief, not a claim of completed user research.", 50, 61, 9, MUTED)
c.showPage()

# Slide 3 - solution flow
header(c, 3, "The solution", "A short path from question to useful support.")
flow = [
    ("1", "Choose a page", "Guided, self-paced, lesson or blank host"),
    ("2", "Ask", "Type a question; use voice when available"),
    ("3", "Get evidence", "Search course or test-job content and show a source link"),
    ("4", "Reach a tutor", "Create a consented help request for the helper inbox"),
]
flow_x = [48, 279, 510, 741]
for i, (num, title, desc) in enumerate(flow):
    x = flow_x[i]
    rr(c, x, 240, 174, 118, PAPER, LINE, 16)
    c.setFillColor(GREEN)
    c.circle(x + 26, 330, 15, fill=1, stroke=0)
    c.setFillColor(PAPER)
    c.setFont("Helvetica-Bold", 11)
    c.drawCentredString(x + 26, 326, num)
    text(c, title, x + 18, 292, 13, FOREST, "Helvetica-Bold")
    para(c, desc, x + 18, 280, 138, "small")
    if i < 3:
        arrow(c, x + 183, 300, flow_x[i + 1] - 10)
rr(c, 48, 121, 410, 66, PALE, None, 12)
text(c, "OFFLINE-CAPABLE BASELINE", 67, 162, 9, GREEN, "Helvetica-Bold")
para(c, "Typed retrieval works without a paid model configured. The demo keeps external AI and messaging off.", 67, 148, 365, "small")
rr(c, 478, 121, 434, 66, HexColor("#FFF3E4"), None, 12)
text(c, "WHEN THE ANSWER ISN'T ENOUGH", 497, 162, 9, HexColor("#985E21"), "Helvetica-Bold")
para(c, "Keep the learner in control: offer a person and send the conversation only with consent.", 497, 148, 392, "small")
text(c, "Answer quality is tied to retrieval and source visibility; the assistant should not invent unsupported answers.", 49, 80, 9, MUTED)
c.showPage()

# Slide 4 - judge routes
header(c, 4, "Open the demo", "Seven direct entry points for judges.")
para(c, "Use the Render service below, then open any route directly. The PDF links are clickable.", 50, 397, 820, "body")
routes = [
    ("Guided learning path", "/savanna/pages/homepage-v1-paced.html", "Structured route through the lesson topics."),
    ("Self-paced learning", "/savanna/pages/homepage-v1-self-paced.html", "Choose any topic without a required order."),
    ("Course lesson", "/savanna/pages/concept-with-navigation.html", "The five-section course lesson and assistant."),
    ("Jobs page", "/savanna/pages/jobs.html", "Career content and job-related support."),
    ("Blank-host assistant demo", "/demo/blank.html", "Shows the component outside Savanna."),
    ("Helper inbox", "/helper", "Tutor view for waiting learner requests."),
    ("API Docs", "/docs", "Interactive API documentation."),
]
positions = []
for i, (label, route, desc) in enumerate(routes):
    col = i % 2
    row = i // 2
    x = 50 + col * 438
    y = 296 - row * 72
    positions.append((x,y))
    rr(c, x, y, 410, 64, PAPER, LINE, 12)
    text(c, label, x + 16, y + 45, 12.3, FOREST, "Helvetica-Bold")
    full = BASE + route
    shown = BASE.replace("https://", "") + route
    para(c, escape(shown), x + 16, y + 38, 378, "link", link=full)
    para(c, escape(desc), x + 16, y + 18, 378, "small")
    c.linkURL(full, (x + 10, y + 8, x + 400, y + 56), relative=0, thickness=0)
rr(c, 50, 40, 848, 32, FOREST, None, 9)
text(c, "SERVICE BASE", 66, 51, 8.2, AMBER, "Helvetica-Bold")
text(c, BASE, 146, 50, 9.5, PAPER, "Helvetica-Bold")
c.linkURL(BASE, (140, 43, 470, 67), relative=0, thickness=0)
text(c, "The direct routes are supplied for the demo; confirm each loads before final submission.", 50, 30, 7.8, MUTED)
c.showPage()

# Slide 5 - architecture and privacy
header(c, 5, "How it fits together", "One assistant module across pages and support.")
# page surfaces
rr(c, 48, 285, 208, 88, PALE, LINE, 14)
text(c, "LEARNER PAGES", 66, 346, 10, GREEN, "Helvetica-Bold")
para(c, "Three Savanna pages<br/>+ blank-host demo", 66, 330, 170, "body")
# component
rr(c, 333, 285, 235, 88, PAPER, LINE, 14)
text(c, "WEB COMPONENT", 351, 346, 10, GREEN, "Helvetica-Bold")
para(c, "One script tag<br/>Shadow-root widget", 351, 330, 195, "body")
# API
rr(c, 648, 285, 264, 88, PAPER, LINE, 14)
text(c, "FASTAPI SERVICE", 666, 346, 10, GREEN, "Helvetica-Bold")
para(c, "Retrieval, source links,<br/>tickets and API docs", 666, 330, 220, "body")
arrow(c, 267, 329, 321)
arrow(c, 578, 329, 636)
# content store and helper flow
rr(c, 118, 145, 294, 82, HexColor("#FFF3E4"), None, 14)
text(c, "COURSE + TEST-JOB CONTENT", 138, 195, 10, HexColor("#985E21"), "Helvetica-Bold")
para(c, "Retrieved sections provide context for answers and citations.", 138, 180, 254, "small")
rr(c, 538, 145, 294, 82, PALE, None, 14)
text(c, "HUMAN FOLLOW-UP", 558, 195, 10, GREEN, "Helvetica-Bold")
para(c, "Consented learner request > helper inbox > reply/status.", 558, 180, 254, "small")
# dashed arrows
c.setStrokeColor(MUTED)
c.setDash(3, 3)
c.line(780, 284, 780, 238)
c.line(780, 238, 685, 238)
c.line(685, 238, 685, 228)
c.line(250, 284, 250, 238)
c.line(250, 238, 265, 228)
c.setDash()
rr(c, 48, 72, 864, 44, FOREST, None, 10)
text(c, "DEMO-SAFE CONFIG", 66, 88, 8.5, AMBER, "Helvetica-Bold")
text(c, "AI_PROVIDER=none  |  OFFLINE_MODE=true  |  no outbound SMS, Telegram or webhook credentials", 178, 87, 10, PAPER, "Helvetica-Bold")
para(c, "Render demo tickets use SQLite at /tmp/escalations.sqlite3 and may be lost on restart or redeploy. Use test data only.", 50, 54, 860, "small")
c.showPage()

# Slide 6 - delivery, fit, and form guidance
header(c, 6, "Track 3 fit and submission", "A working demo, with the human gate stated honestly.")
# two columns
rr(c, 48, 245, 414, 140, PAPER, LINE, 14)
text(c, "BUILT IN THE CURRENT PROJECT", 68, 355, 10, GREEN, "Helvetica-Bold")
para(c, "- Assistant is embedded on all three Savanna learner pages.<br/>- Course answers link to lesson sections; job content is a second source.<br/>- Tutor escalation and helper inbox support human follow-up.<br/>- A blank-host page demonstrates portability.", 68, 337, 370, "card")
rr(c, 498, 245, 414, 140, HexColor("#FFF3E4"), None, 14)
text(c, "STILL NEEDS HUMAN EVIDENCE", 518, 355, 10, HexColor("#985E21"), "Helvetica-Bold")
para(c, "The Track 3 gate is not established by this deck or automated checks. A co-designer must complete the main task unaided with a screen reader, keyboard only, sound off, and actual 200% zoom. Fluent-speaker and real-device/network checks also remain.", 518, 337, 370, "card")
text(c, "FORM FIELDS", 50, 209, 10, GREEN, "Helvetica-Bold")
# form rows
form_rows = [
    ("Pitch Deck Link", "After uploading this PDF to Drive/OneDrive, paste a viewer link that judges can open."),
    ("Pitch Deck Upload", "Upload this PDF."),
    ("MVP Link", "Use the Render service link below; include the direct pages listed on slide 4. GitHub is useful as source code, but Render is the runnable MVP."),
    ("MVP Upload", "Upload a clean source ZIP for the deployed commit; exclude .env, credentials and generated files."),
]
for idx, (name, desc) in enumerate(form_rows):
    y = 185 - idx * 27
    text(c, name, 55, y, 9.5, FOREST, "Helvetica-Bold")
    para(c, desc, 190, y + 3, 700, "small")
rr(c, 50, 39, 848, 37, DEEP, None, 9)
text(c, "MVP LINK", 66, 53, 8.2, AMBER, "Helvetica-Bold")
text(c, BASE, 146, 51, 10, PAPER, "Helvetica-Bold")
c.linkURL(BASE, (140, 43, 460, 68), relative=0, thickness=0)
text(c, "Share responsibly. Never upload real learner data or secrets.", 490, 52, 9, HexColor("#D6E7DA"))
c.showPage()

c.save()
print(f"Created {OUT}")
