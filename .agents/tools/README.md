# Repository tools

- `python3 .agents/tools/source-state.py` prints the source fingerprint used by the validation ledger, excluding the ledger itself and ignored build/runtime files.
- `python3 .agents/tools/review-collage.py output.png 'Label=screenshot.png' ...` combines screenshots at a common height with labels and preserved aspect ratios; requires Pillow.
