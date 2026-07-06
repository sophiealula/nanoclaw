#!/usr/bin/env python3
"""Retroactively export Granola AI summaries (from muesli's local DB) into the Obsidian vault.
Writes Meetings/{date}_{slug}_granola-summary.md next to each transcript. Distinct from the
Claude-generated *-summary.md files. Dry-run by default; pass --write to actually write."""
import os, re, subprocess, sys
from collections import defaultdict

MUESLI = os.path.expanduser("~/.cargo/bin/muesli")
MEETINGS = os.path.expanduser("~/obsidian-vault/personal/Meetings")
WRITE = "--write" in sys.argv

def slugify(title):
    s = title.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-") or "untitled"

def muesli(*args):
    return subprocess.run([MUESLI, *args], capture_output=True, text=True).stdout

# Existing transcript basenames (exclude already-generated summaries), to pair summaries to transcripts.
transcripts = {f[:-3] for f in os.listdir(MEETINGS)
               if f.endswith(".md") and not f.endswith("-summary.md")}
tx_by_date = defaultdict(list)
for b in transcripts:
    if len(b) > 11 and b[10] == "_":
        tx_by_date[b[:10]].append(b)

def pair_base(date, title):
    """Find the transcript file this summary belongs next to; muesli truncates long slugs."""
    s = slugify(title)
    if f"{date}_{s}" in transcripts:
        return f"{date}_{s}"
    for c in tx_by_date.get(date, []):
        cs = c[11:]
        if s.startswith(cs) or cs.startswith(s):
            return c
    if len(tx_by_date.get(date, [])) == 1:
        return tx_by_date[date][0]
    return None

rows = []
for line in muesli("local").splitlines():
    parts = line.split("\t")
    if len(parts) >= 3:
        rows.append((parts[0], parts[1], parts[2]))

written = skipped_nosum = aligned = orphan = 0
seen = set()
for doc_id, date, title in rows:
    out = muesli("show", doc_id)
    if "No summary available" in out or not out.strip():
        skipped_nosum += 1
        continue
    paired = pair_base(date, title)
    base = paired if paired else f"{date}_{slugify(title)}"
    aligned += 1 if paired else 0
    orphan += 0 if paired else 1
    name = f"{base}_granola-summary"
    if name in seen:                       # collision guard (e.g. multiple Untitled same day)
        name = f"{name}-{doc_id[:8]}"
    seen.add(name)
    # Body: drop the first two header lines (title dup + "date — id"); keep Attendees + summary.
    body = "\n".join(out.splitlines()[2:]).strip()
    doc = (f"---\ntitle: \"{title}\"\ndate: {date}\nsource: Granola AI summary\n"
           f"granola_id: {doc_id}\n---\n\n# {title} — Granola AI summary\n\n{body}\n")
    if WRITE:
        with open(os.path.join(MEETINGS, f"{name}.md"), "w") as f:
            f.write(doc)
    written += 1

print(f"docs total:        {len(rows)}")
print(f"no summary (skip): {skipped_nosum}")
print(f"summaries:         {written}  (paired w/ transcript: {aligned}, standalone: {orphan})")
print("MODE:", "WROTE FILES" if WRITE else "DRY-RUN (no files written)")
