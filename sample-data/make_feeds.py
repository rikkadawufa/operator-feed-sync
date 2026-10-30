"""Writes the made-up operator feeds for each demo day into sample-data/feeds/.

Three fictional operators, each with its own format and field names:
  northgate  XML, sizes in m2, availability open/let/withdrawn
  quayside   CSV, sizes in sq ft, prices like "$65.00", Vacant/Occupied/Off market
  pinecrest  JSON API, decimal commas, nested fields, free/reserved/occupied/retired

Run it again after editing; the files are committed so the demo doesn't depend on it.
"""
import csv
import io
import json
from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(__file__).resolve().parent / "feeds"
IMG = "https://images.example.com/larkspur"

NORTHGATE = [
    # ref, name, type, m2, price, district, climate, availability
    ("NG-101", "Locker 1A, ground floor", "Locker", "1.5", "39.00", "Riverside", "no", "open"),
    ("NG-102", "Small unit 2B", "Small Unit", "4.5", "79.00", "Riverside", "yes", "open"),
    ("NG-103", "Small unit 2C", "Small Unit", "5", "85.00", "Riverside", "yes", "open"),
    ("NG-104", "Medium unit 3A", "Medium Unit", "9", "139.00", "Old Town", "yes", "open"),
    ("NG-105", "Medium unit 3B", "Medium Unit", "10", "149.00", "Old Town", "no", "open"),
    ("NG-106", "Large unit 4A, drive-up", "Large Unit", "18", "229.00", "Old Town", "no", "open"),
    ("NG-107", "Large unit 4B, drive-up", "Large Unit", "20", "245.00", "Old Town", "no", "open"),
    ("NG-108", "Covered parking bay P3", "Parking Bay", "12.5", "95.00", "Harbor", "no", "open"),
    ("NG-109", "Covered parking bay P4", "Parking Bay", "12.5", "95.00", "Harbor", "no", "open"),
    ("NG-110", "Locker 1B, ground floor", "Locker", "1.5", "39.00", "Riverside", "no", "open"),
    ("NG-111", "Medium unit 3C", "Medium Unit", "9", "139.00", "Old Town", "yes", "open"),
    ("NG-112", "Small unit 2D", "Small Unit", "4.5", "79.00", "Riverside", "yes", "open"),
]

QUAYSIDE = [
    # Unit ID, Unit Name, Category, sq ft, rate, neighborhood, climate, availability
    ("Q-01", "Locker 3, lower deck", "XS", "16", "$29.00", "Harbor", "N", "Vacant"),
    ("Q-02", "Locker 4, lower deck", "XS", "16", "$29.00", "Harbor", "N", "Vacant"),
    ("Q-03", "Unit 12, upper deck", "S", "50", "$65.00", "Harbor", "Y", "Vacant"),
    ("Q-04", "Unit 14, upper deck", "S", "50", "$65.00", "Harbor", "Y", "Vacant"),
    ("Q-05", "Unit 21 (corner)", "M", "100", "$118.00", "Dockside", "Y", "Vacant"),
    ("Q-06", "Unit 22", "M", "100", "$112.00", "Dockside", "N", "Vacant"),
    ("Q-07", "Unit 30, roll-up door", "L", "200", "$199.00", "Dockside", "N", "Vacant"),
    ("Q-08", "Unit 31, roll-up door", "L", "200", "$199.00", "Dockside", "N", "Vacant"),
    ("Q-09", "Outdoor bay B2", "Parking", "160", "$85.00", "Dockside", "N", "Vacant"),
    ("Q-10", "Outdoor bay B3", "Parking", "160", "$85.00", "Dockside", "N", "Vacant"),
]

PINECREST = [
    # unit_code, label, kind, area_sqm, amount, district, climate, state
    ("PC-A01", "A01 locker", "locker", "1,8", "45,00", "Hillcrest", False, "free"),
    ("PC-B04", "B04 small room", "small", "4,2", "72,50", "Hillcrest", True, "free"),
    ("PC-B05", "B05 small room", "small", "4,2", "72,50", "Hillcrest", True, "reserved"),
    ("PC-C11", "C11 medium room", "medium", "8,6", "128,00", "Hillcrest", True, "free"),
    ("PC-D02", "D02 large room", "large", "16,0", "210,00", "Pine Hill", False, "free"),
    ("PC-P07", "P07 indoor parking", "parking", "13,5", "99,00", "Pine Hill", False, "free"),
]


def northgate_xml(rows):
    parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<feed operator="northgate">']
    for ref, name, kind, size, price, district, climate, availability in rows:
        slug = ref.lower()
        parts.append(
            f'  <listing ref="{ref}">\n'
            f"    <name>{escape(name)}</name>\n    <unitType>{kind}</unitType>\n    <sizeSqm>{size}</sizeSqm>\n"
            f"    <pricePerMonth>{price}</pricePerMonth>\n    <district>{district}</district>\n"
            f"    <climate>{climate}</climate>\n    <photo>{IMG}/{slug}.jpg</photo>\n"
            f"    <availability>{availability}</availability>\n  </listing>"
        )
    parts.append("</feed>")
    return "\n".join(parts) + "\n"


def quayside_csv(rows):
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(["Unit ID", "Unit Name", "Category", "Size (sq ft)", "Monthly Rate", "Neighborhood", "Climate", "Photo", "Availability"])
    for unit, name, category, sqft, rate, hood, climate, availability in rows:
        writer.writerow([unit, name, category, sqft, rate, hood, climate, f"{IMG}/{unit.lower()}.jpg", availability])
    return buffer.getvalue()


def pinecrest_json(rows):
    units = [
        {
            "unit_code": code, "label": label, "kind": kind,
            "dimensions": {"area_sqm": area},
            "price": {"amount": amount, "currency": "USD"},
            "location": {"district": district},
            "features": {"climate": "yes" if climate else "no"},
            "media": {"main": f"{IMG}/{code.lower()}.jpg"},
            "state": state,
        }
        for code, label, kind, area, amount, district, climate, state in rows
    ]
    return json.dumps({"generated_at": "2026-10-30T06:00:00Z", "data": {"units": units}}, indent=2) + "\n"


def edit(rows, ref, **changes):
    fields = ["ref", "name", "kind", "size", "price", "area", "climate", "status"]
    out = []
    for row in rows:
        if row[0] == ref:
            values = dict(zip(fields, row))
            values.update(changes)
            row = tuple(values[name] for name in fields)
        out.append(row)
    return out


def write(day, name, text):
    path = OUT / day / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode("utf-8"))


def main():
    # Day 1: first sync. Day 2 reuses day 1 files unchanged.
    write("day1", "northgate.xml", northgate_xml(NORTHGATE))
    write("day1", "quayside.csv", quayside_csv(QUAYSIDE))

    # Day 3: normal changes plus three broken quayside rows.
    ng3 = edit(NORTHGATE, "NG-103", price="92.00")
    ng3 = edit(ng3, "NG-105", status="let")
    ng3 = [row for row in ng3 if row[0] != "NG-108"]
    ng3.append(("NG-113", "Large unit 4C, drive-up", "Large Unit", "20", "249.00", "Old Town", "no", "open"))
    write("day3", "northgate.xml", northgate_xml(ng3))
    q3 = edit(QUAYSIDE, "Q-04", price="")
    q3 = edit(q3, "Q-07", kind="Jumbo")
    q3.append(("Q-09", "Outdoor bay B2", "Parking", "160", "$79.00", "Dockside", "N", "Vacant"))
    write("day3", "quayside.csv", quayside_csv(q3))

    # Day 5: northgate sends a partial file (4 of 11 live units), one price changed.
    ng5 = edit([row for row in ng3 if row[0] in ("NG-101", "NG-102", "NG-103", "NG-104")], "NG-102", price="75.00")
    write("day5", "northgate.xml", northgate_xml(ng5))

    # Day 6: full feed again; NG-108 is back on the market. Quayside fixed its rows.
    ng6 = edit(ng3, "NG-102", price="75.00")
    ng6.insert(7, edit(NORTHGATE, "NG-108")[7])
    write("day6", "northgate.xml", northgate_xml(ng6))
    write("day6", "quayside.csv", quayside_csv(QUAYSIDE))

    # Day 7: a new operator's API.
    write("day7", "pinecrest.json", pinecrest_json(PINECREST))
    print(f"Wrote feeds to {OUT.name}/ (day1, day3, day5, day6, day7)")


if __name__ == "__main__":
    main()
