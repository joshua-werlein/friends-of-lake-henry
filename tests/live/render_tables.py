# Renders cumulative winner spreadsheets in the layout the production reads describe: one row per date, Firearm and Gift Card
# columns, and a headingless bonus column whose few cells carry their own label. Writes JPEG (as Facebook serves photos) at the
# original ~961 px width and an enlarged copy at 1540 px, the width the Photo Worker asks the Images binding for.
# Usage: python -I render_tables.py cells.json out_dir   (cells.json: {night: [[date, column 1-3, cell text], ...]})
import json, sys
from PIL import Image, ImageDraw, ImageFont

cells = json.load(open(sys.argv[1], encoding='utf8'))
out = sys.argv[2]
font = ImageFont.truetype('C:/Windows/Fonts/calibri.ttf', 15)
bold = ImageFont.truetype('C:/Windows/Fonts/calibrib.ttf', 15)
COLS = [('Date', 70), ('Firearm', 300), ('Gift Card', 300), ('', 290)]
ROW = 22
for night, rows in cells.items():
    days = int(night)
    width = sum(w for _, w in COLS) + 1
    img = Image.new('RGB', (width, ROW * (days + 1) + 1), 'white')
    d = ImageDraw.Draw(img)
    x = 0
    for title, w in COLS:
        d.rectangle([x, 0, x + w, ROW], fill=(221, 235, 247), outline=(160, 160, 160))
        d.text((x + 5, 3), title, fill='black', font=bold)
        x += w
    for n in range(1, days + 1):
        y = ROW * n
        x = 0
        for _, w in COLS:
            d.rectangle([x, y, x + w, y + ROW], outline=(200, 200, 200))
            x += w
        d.text((5, y + 3), f'Nov {n}', fill='black', font=font)
    for date, col, text in rows:
        n = int(date[-2:])
        x = sum(w for _, w in COLS[:col])
        d.text((x + 5, ROW * n + 3), text, fill='black', font=font)
    img.save(f'{out}/table-{night}.jpg', 'JPEG', quality=80)
    big = img.resize((1540, round(img.height * 1540 / img.width)), Image.LANCZOS)
    big.save(f'{out}/table-{night}-1540.jpg', 'JPEG', quality=90)
    print(night, img.size, big.size)
