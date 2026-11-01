#!/usr/bin/env python3
"""
build_readme_table.py — Emit a markdown tool inventory from tools.json.

Generates a per-category table with:
  - Tool title (linked to project_url if present)
  - One-line description
  - Capability icon: green = plug-and-play, yellow = environment-dependent
  - Flag tags (sudo / gui / interactive / hardware)

Usage:
  python build_readme_table.py               # emits to stdout
  python build_readme_table.py > table.md
"""

import json
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

DATA = Path(__file__).resolve().parent.parent / "data" / "tools.json"

CATEGORY_ORDER = [
    ("anonsurf", "🛡 Anonymously Hiding"),
    ("information_gathering", "🔍 Information Gathering"),
    ("wordlist_generator", "📚 Wordlist Generator"),
    ("wireless_attack", "📶 Wireless Attack"),
    ("sql_injection", "🧩 SQL Injection"),
    ("phishing_attack", "🎣 Phishing Attack"),
    ("web_attack", "🌐 Web Attack"),
    ("post_exploitation", "🔧 Post Exploitation"),
    ("forensics", "🕵 Forensics"),
    ("payload_creator", "📦 Payload Creation"),
    ("exploit_frameworks", "🧰 Exploit Framework"),
    ("reverse_engineering", "🔁 Reverse Engineering"),
    ("ddos", "⚡ DDOS"),
    ("remote_administration", "🖥 RAT"),
    ("xss_attack", "💥 XSS"),
    ("steganography", "🖼 Steganography"),
    ("active_directory", "🏢 Active Directory"),
    ("cloud_security", "☁ Cloud Security"),
    ("mobile_security", "📱 Mobile Security"),
    ("other_tools", "✨ Other"),
    ("android_attack", "📱 Android Attack"),
    ("email_verifier", "📧 Email Verifier"),
    ("hash_crack", "🔑 Hash Crack"),
    ("homograph_attacks", "🎭 Homograph"),
    ("mix_tools", "🧪 Mix Tools"),
    ("payload_injection", "💉 Payload Injection"),
    ("socialmedia", "📱 Social Media"),
    ("socialmedia_finder", "🔎 Social Media Finder"),
    ("web_crawling", "🕸 Web Crawling"),
    ("wifi_jamming", "📡 Wifi Jamming"),
]


def _one_liner(s: str) -> str:
    if not s:
        return "—"
    line = s.replace("\r", "").split("\n", 1)[0].strip()
    # Collapse runs of whitespace
    line = " ".join(line.split())
    # Escape pipes for markdown tables
    return line.replace("|", "\\|")


def _status(caps: dict) -> tuple[str, list[str]]:
    tags = []
    if caps.get("interactive"):
        tags.append("interactive")
    if caps.get("requires_sudo"):
        tags.append("sudo")
    if caps.get("requires_gui"):
        tags.append("gui")
    if caps.get("requires_hardware"):
        tags.append("hw")
    if caps.get("long_running"):
        tags.append("long")

    icon = "🟢" if caps.get("runnable_by_claude") else "🟡"
    return icon, tags


def _title_cell(t: dict) -> str:
    title = t["title"].replace("|", "\\|")
    url = t.get("project_url") or ""
    if url:
        return f"[{title}]({url})"
    return title


def main():
    doc = json.loads(DATA.read_text(encoding="utf-8"))
    tools = doc["tools"]

    # Group by category, in our preferred order, appending anything we didn't list
    by_cat: dict[str, list[dict]] = {}
    for t in tools:
        by_cat.setdefault(t["category"], []).append(t)

    ordered = [(k, lbl) for k, lbl in CATEGORY_ORDER if k in by_cat]
    leftovers = [k for k in by_cat if k not in {kk for kk, _ in CATEGORY_ORDER}]
    for k in sorted(leftovers):
        ordered.append((k, k))

    # Summary line
    total = len(tools)
    runnable = sum(1 for t in tools if t["capabilities"].get("runnable_by_claude"))
    print(f"**{total} tools total** — 🟢 {runnable} plug-and-play · "
          f"🟡 {total - runnable} environment-dependent\n")

    for cat_key, label in ordered:
        cat_tools = sorted(by_cat[cat_key], key=lambda t: t["title"].lower())
        print(f"\n### {label} ({len(cat_tools)})\n")
        print("| Tool | What it does | Claude | Flags |")
        print("|---|---|:---:|---|")
        for t in cat_tools:
            icon, tags = _status(t["capabilities"])
            tag_cell = " ".join(f"`{x}`" for x in tags) if tags else "—"
            desc = _one_liner(t.get("description"))
            if t.get("archived"):
                tag_cell = f"`archived` {tag_cell}".strip()
            print(f"| {_title_cell(t)} | {desc} | {icon} | {tag_cell} |")


if __name__ == "__main__":
    main()
