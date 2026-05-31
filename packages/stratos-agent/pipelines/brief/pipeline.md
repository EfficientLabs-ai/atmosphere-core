# brief — a 3-stage ICM pipeline (outline → draft → polish)

Each stage does ONE job and writes a plain-text, human-editable `output.md`. Edit any stage's
output between runs; downstream stages re-run automatically (hash-based freshness). The numbered
stage directories are the order.
