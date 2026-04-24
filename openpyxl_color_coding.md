# openpyxl Excel Color-Coding — Reusable Reference

## Imports

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
```

---

## 1. Header Row

```python
hdr_font = Font(bold=True, color="FFFFFF", name="Arial", size=10)
hdr_fill = PatternFill("solid", start_color="1F4E79")   # dark navy
thin     = Side(style='thin', color="CCCCCC")
border   = Border(left=thin, right=thin, top=thin, bottom=thin)

headers    = ["#", "First", "Last", "Title", "Company", "Industry", "Email"]
col_widths = [5,    12,      16,     50,       30,         22,         38]

for i, (header, width) in enumerate(zip(headers, col_widths), 1):
    cell = ws.cell(row=1, column=i, value=header)
    cell.font      = hdr_font
    cell.fill      = hdr_fill
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    cell.border    = border
    ws.column_dimensions[get_column_letter(i)].width = width

ws.row_dimensions[1].height = 30   # taller header
ws.freeze_panes = "A2"             # lock header on scroll
```

---

## 2. Category Color Banding

```python
# Soft pastel hex codes — no # prefix in openpyxl
industry_colors = {
    "Aerospace & Defense": "D6E4F7",   # soft blue
    "Automotive":          "D9F0D3",   # soft green
    "Food & Beverage":     "FFF2CC",   # soft yellow
    "Building Materials":  "F4CCCC",   # soft red/pink
    "Construction":        "EAD1DC",   # soft purple
}

# Look up fill per row, then apply to every cell in that row
color = industry_colors.get(row_category, "FFFFFF")   # default: white
fill  = PatternFill("solid", start_color=color)

for col_idx, value in enumerate(row_values, 1):
    cell        = ws.cell(row=row_num, column=col_idx, value=value)
    cell.font   = Font(name="Arial", size=9)
    cell.fill   = fill
    cell.border = border
    cell.alignment = Alignment(vertical="center", wrap_text=True)

ws.row_dimensions[row_num].height = 18
```

---

## 3. Alternating Row Banding (no categories)

```python
alt_fill = PatternFill("solid", start_color="EBF3FB")   # light blue-grey

for row_idx, row_data in enumerate(data, 2):
    fill = alt_fill if row_idx % 2 == 0 else None
    for col_idx, value in enumerate(row_data, 1):
        cell      = ws.cell(row=row_idx, column=col_idx, value=value)
        cell.font = Font(name="Arial", size=9)
        if fill:
            cell.fill = fill
        cell.border = border
```

---

## 4. Conditional Cell Coloring (Yes / No status)

```python
green_font = Font(name="Arial", size=9, bold=True, color="1E6B31")   # dark green
red_font   = Font(name="Arial", size=9, bold=True, color="C00000")   # dark red

status_cell = ws.cell(row=row_num, column=10)   # e.g. "In HubSpot" column
if status_cell.value == "Yes":
    status_cell.font = green_font
else:
    status_cell.font = red_font
```

---

## 5. Legend Block

```python
legend_row = len(data) + 3
ws.cell(row=legend_row, column=1, value="Color Key:").font = Font(bold=True, name="Arial", size=10)

for idx, (label, color) in enumerate(industry_colors.items()):
    r    = legend_row + 1 + idx
    cell = ws.cell(row=r, column=1, value=label)
    cell.fill   = PatternFill("solid", start_color=color)
    cell.font   = Font(name="Arial", size=9, bold=True)
    cell.border = border
```

---

## 6. Summary Block with Excel Formulas

```python
sr = len(data) + 3
summary = [
    ("Total Contacts:",    f"=COUNTA(B2:B{len(data)+1})"),
    ("With Email:",        f'=COUNTIF(G2:G{len(data)+1},"<>—")'),
    ("Unique Companies:",  f"=SUMPRODUCT(1/COUNTIF(E2:E{len(data)+1},E2:E{len(data)+1}))"),
    ("In HubSpot:",        f'=COUNTIF(J2:J{len(data)+1},"Yes")'),
]

for i, (label, formula) in enumerate(summary):
    ws.cell(row=sr+i, column=1, value=label).font  = Font(bold=True, name="Arial", size=10)
    ws.cell(row=sr+i, column=2, value=formula).font = Font(bold=True, name="Arial", size=10)
```

---

## Color Palette Reference

| Role             | Hex       | Notes                        |
|------------------|-----------|------------------------------|
| Header fill      | `1F4E79`  | Dark navy                    |
| Header text      | `FFFFFF`  | White                        |
| Alternating row  | `EBF3FB`  | Ice blue-grey                |
| Aerospace        | `D6E4F7`  | Soft blue                    |
| Automotive       | `D9F0D3`  | Soft green                   |
| Food & Beverage  | `FFF2CC`  | Soft yellow                  |
| Building Mats    | `F4CCCC`  | Soft red/pink                |
| Construction     | `EAD1DC`  | Soft purple                  |
| "Yes" status     | `1E6B31`  | Dark green (font color)      |
| "No" status      | `C00000`  | Dark red (font color)        |
| Border lines     | `CCCCCC`  | Light grey                   |

---

## Key Rules

1. **No `#` prefix** — openpyxl hex codes are bare strings: `"1F4E79"`, not `"#1F4E79"`
2. **`PatternFill` type is always `"solid"`** — other fill types rarely work reliably
3. **Apply `border` and `font` to every cell individually** — there is no row-level shortcut
4. **`freeze_panes = "A2"`** — always set this so the header stays visible on scroll
5. **Use `wrap_text=True`** only on columns with long text (titles, descriptions)
6. **Column widths** go on `ws.column_dimensions[get_column_letter(i)].width` — set these in the header loop
7. **Row heights** go on `ws.row_dimensions[row_num].height` — set per row as you write data

---

## Save & Output (Claude computer environment)

```python
wb.save("/home/claude/MyFile.xlsx")

# Then copy to the outputs folder so the user can download it:
import shutil
shutil.copy("/home/claude/MyFile.xlsx", "/mnt/user-data/outputs/MyFile.xlsx")
```
