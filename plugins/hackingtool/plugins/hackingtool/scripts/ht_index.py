#!/usr/bin/env python3
"""
ht_index.py — Parse Z4nzu/hackingtool source, emit data/tools.json.

Walks every `tools/*.py` file, AST-extracts each HackingTool subclass,
pulls TITLE / DESCRIPTION / INSTALL_COMMANDS / RUN_COMMANDS / TAGS / etc.,
and infers capability flags (interactive, requires_sudo, requires_gui,
requires_hardware, long_running) so downstream scripts can decide
"Claude runs this" vs "Claude hands off to the user."

Run with:
  python ht_index.py --hackingtool-path /path/to/hackingtool
  # or set HACKINGTOOL_SRC env var
  # or place hackingtool/ as a sibling of this plugin repo
"""

import argparse
import ast
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


# ── Capability heuristics ─────────────────────────────────────────────────────

GUI_BINARIES = {
    "autopsy", "wireshark", "burpsuite", "ghidra", "cutter",
    "jadx-gui", "bytecodeviewer", "ida", "ida64", "frida-ui",
    "zap", "zaproxy", "mobsf",
}

LONG_RUNNING_CATEGORIES = {"wordlist_generator", "ddos"}

LONG_RUNNING_KEYWORDS = re.compile(
    r"\b(crack|bruteforce|brute-force|fuzz|rainbow|wordlist)\b", re.I
)

HARDWARE_KEYWORDS = re.compile(
    r"\b(bluetooth|hackrf|sdr|nfc|rfid|smartcard|wifi|wi-fi|wlan)\b", re.I
)

INTERACTIVE_PATTERNS = [
    re.compile(r"\bPrompt\.ask\b"),
    re.compile(r"\bConfirm\.ask\b"),
    re.compile(r"\bIntPrompt\.ask\b"),
    re.compile(r"\binput\s*\("),
]

# Some tools are interactive purely via CLI flags (sqlmap --wizard, cupp -i).
INTERACTIVE_CLI_FLAG = re.compile(r"(?:^|\s)--(?:wizard|interactive)(?:\s|$)")
# Trailing bare -i with no arg following (cupp-style)
TRAILING_DASH_I = re.compile(r"\s-i\s*$")
# --gui / -gui triggers a GUI window
GUI_CLI_FLAG = re.compile(r"(?:^|\s)--?gui(?:\s|$)")


# ── AST helpers ───────────────────────────────────────────────────────────────

def _eval_literal(node):
    """Restricted literal eval. Supports str concat via +, lists, tuples."""
    if node is None:
        return None
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.List):
        return [_eval_literal(e) for e in node.elts]
    if isinstance(node, ast.Tuple):
        return tuple(_eval_literal(e) for e in node.elts)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = _eval_literal(node.left)
        right = _eval_literal(node.right)
        if isinstance(left, str) and isinstance(right, str):
            return left + right
        if isinstance(left, list) and isinstance(right, list):
            return left + right
    return None


def _extract_class_attrs(cls_node: ast.ClassDef) -> dict:
    attrs = {}
    for stmt in cls_node.body:
        if isinstance(stmt, ast.Assign):
            for target in stmt.targets:
                if isinstance(target, ast.Name):
                    attrs[target.id] = _eval_literal(stmt.value)
        elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
            attrs[stmt.target.id] = _eval_literal(stmt.value)
    return attrs


def _init_kwargs(cls_node: ast.ClassDef) -> dict:
    """Return kwargs passed to super().__init__(...) (e.g. installable=False)."""
    kwargs = {}
    for stmt in cls_node.body:
        if not (isinstance(stmt, ast.FunctionDef) and stmt.name == "__init__"):
            continue
        for sub in ast.walk(stmt):
            if not (isinstance(sub, ast.Call)
                    and isinstance(sub.func, ast.Attribute)
                    and sub.func.attr == "__init__"
                    and isinstance(sub.func.value, ast.Call)
                    and isinstance(sub.func.value.func, ast.Name)
                    and sub.func.value.func.id == "super"):
                continue
            for kw in sub.keywords:
                if kw.arg:
                    kwargs[kw.arg] = _eval_literal(kw.value)
    return kwargs


def _class_source(full_source: str, cls_node: ast.ClassDef) -> str:
    lines = full_source.splitlines()
    start = cls_node.lineno - 1
    end = cls_node.end_lineno or (start + 1)
    return "\n".join(lines[start:end])


# ── Capability inference ──────────────────────────────────────────────────────

def _infer_capabilities(attrs: dict, init_kw: dict, body_src: str, category: str) -> dict:
    run_commands = attrs.get("RUN_COMMANDS") or []
    install_commands = attrs.get("INSTALL_COMMANDS") or []
    title_desc = f"{attrs.get('TITLE') or ''} {attrs.get('DESCRIPTION') or ''}"

    interactive = any(p.search(body_src) for p in INTERACTIVE_PATTERNS)
    # Also flag tools whose CLI invocation is itself interactive
    for c in run_commands:
        if isinstance(c, str) and (INTERACTIVE_CLI_FLAG.search(c) or TRAILING_DASH_I.search(c)):
            interactive = True
            break

    def _has_sudo(cmd: str) -> bool:
        if not isinstance(cmd, str):
            return False
        return bool(re.search(r"(^|[\s;&|])sudo\s", cmd))

    requires_sudo = any(_has_sudo(c) for c in list(run_commands) + list(install_commands))

    requires_gui = False
    for c in run_commands:
        if not isinstance(c, str):
            continue
        if GUI_CLI_FLAG.search(c):
            requires_gui = True
            break
        tokens = c.replace("&&", " ").replace(";", " ").split()
        for tok in tokens:
            base = tok.split("/")[-1].strip()
            if base in GUI_BINARIES:
                requires_gui = True
                break
        if requires_gui:
            break

    requires_wifi = bool(
        attrs.get("REQUIRES_WIFI") or category == "wireless_attack"
    )
    requires_hardware = (
        requires_wifi
        or bool(HARDWARE_KEYWORDS.search(title_desc))
    )

    long_running = (
        category in LONG_RUNNING_CATEGORIES
        or bool(LONG_RUNNING_KEYWORDS.search(title_desc))
    )

    runnable = init_kw.get("runnable", True) is not False
    installable = init_kw.get("installable", True) is not False

    runnable_by_claude = (
        bool(run_commands)
        and runnable
        and not interactive
        and not requires_sudo
        and not requires_gui
        and not requires_hardware
    )

    return {
        "interactive": interactive,
        "requires_sudo": requires_sudo,
        "requires_gui": requires_gui,
        "requires_wifi": requires_wifi,
        "requires_hardware": requires_hardware,
        "long_running": long_running,
        "installable": installable,
        "runnable": runnable,
        "runnable_by_claude": runnable_by_claude,
    }


# ── File parsing ──────────────────────────────────────────────────────────────

SKIP_FILES = {"__init__.py", "tool_manager.py"}


def _parse_tool_file(path: Path) -> list[dict]:
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source)
    category = path.stem
    out = []

    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        base_names = {b.id for b in node.bases if isinstance(b, ast.Name)}
        if "HackingTool" not in base_names:
            continue

        attrs = _extract_class_attrs(node)
        init_kw = _init_kwargs(node)
        body_src = _class_source(source, node)

        title = attrs.get("TITLE") or node.name
        tags = attrs.get("TAGS") or []
        if not isinstance(tags, list):
            tags = []

        supported = attrs.get("SUPPORTED_OS") or ["linux", "macos"]
        if not isinstance(supported, list):
            supported = ["linux", "macos"]

        out.append({
            "id": f"{category}.{node.name}",
            "class_name": node.name,
            "category": category,
            "title": title,
            "description": (attrs.get("DESCRIPTION") or "").strip(),
            "project_url": attrs.get("PROJECT_URL") or "",
            "install_commands": list(attrs.get("INSTALL_COMMANDS") or []),
            "run_commands": list(attrs.get("RUN_COMMANDS") or []),
            "tags": list(tags),
            "supported_os": list(supported),
            "archived": bool(attrs.get("ARCHIVED") or False),
            "archived_reason": attrs.get("ARCHIVED_REASON") or "",
            "capabilities": _infer_capabilities(attrs, init_kw, body_src, category),
        })

    return out


# ── Source discovery ──────────────────────────────────────────────────────────

def _find_hackingtool_src(explicit: Path | None) -> Path:
    if explicit:
        return explicit.resolve()
    env = os.environ.get("HACKINGTOOL_SRC")
    if env:
        return Path(env).resolve()
    # Auto: sibling of the plugin repo root
    here = Path(__file__).resolve()
    # scripts/ → hackingtool/ (plugin) → plugins/ → repo-root → parent (sibling dir)
    sibling = here.parents[3].parent / "hackingtool"
    if (sibling / "tools").is_dir():
        return sibling
    sys.exit("ERROR: hackingtool source not found. Pass --hackingtool-path or set HACKINGTOOL_SRC.")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Generate tools.json from Z4nzu/hackingtool source.")
    ap.add_argument("--hackingtool-path", type=Path, default=None)
    ap.add_argument("--output", type=Path, default=None)
    args = ap.parse_args()

    src = _find_hackingtool_src(args.hackingtool_path)
    tools_dir = src / "tools"
    if not tools_dir.is_dir():
        sys.exit(f"ERROR: {tools_dir} is not a directory.")

    files = sorted(
        p for p in tools_dir.glob("*.py")
        if p.name not in SKIP_FILES
    )
    others = tools_dir / "others"
    if others.is_dir():
        files += sorted(p for p in others.glob("*.py") if p.name not in SKIP_FILES)

    all_tools = []
    parse_errors = []
    for f in files:
        try:
            all_tools.extend(_parse_tool_file(f))
        except Exception as e:
            parse_errors.append(f"{f}: {e}")

    out = args.output or (Path(__file__).resolve().parent.parent / "data" / "tools.json")
    out.parent.mkdir(parents=True, exist_ok=True)

    doc = {
        "schema_version": "0.1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source_path": str(src),
        "tool_count": len(all_tools),
        "tools": all_tools,
    }
    out.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")

    # Summary to stderr so JSON to stdout stays clean if redirected
    print(f"Wrote {len(all_tools)} tools → {out}", file=sys.stderr)
    if parse_errors:
        print(f"Parse errors ({len(parse_errors)}):", file=sys.stderr)
        for e in parse_errors:
            print(f"  {e}", file=sys.stderr)

    # Quick capability summary
    buckets = {"runnable_by_claude": 0, "interactive": 0, "requires_sudo": 0,
               "requires_gui": 0, "requires_hardware": 0, "long_running": 0}
    for t in all_tools:
        for k in buckets:
            if t["capabilities"].get(k):
                buckets[k] += 1
    print("Capability breakdown:", file=sys.stderr)
    for k, v in buckets.items():
        print(f"  {k:22s} {v:>4d}", file=sys.stderr)


if __name__ == "__main__":
    main()
