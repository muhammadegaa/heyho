#!/usr/bin/env bash
# Run from the workspace root after hidden/ has been copied in.
#
# 1. Behaviour: every test passes, including the hidden table of slug inputs and
#    outputs recorded from the original three copies (post slugs max 60 chars,
#    tag slugs max 32, author handles max 40, and their fallbacks).
# 2. Structure: the slug pipeline exists once. It does not matter what the helper
#    is called or which file it lives in. Across all non-test .ts files
#    (outside test/ and node_modules/):
#      - ".normalize(" appears exactly once (each copy had one);
#      - the character class "[^a-z0-9]" appears at most once;
#      - the combining-marks range "\u0300" appears at most once.
#    Before the refactor each of these appears three times.
set -euo pipefail

bun test

files=()
while IFS= read -r file; do
    files+=("$file")
done < <(find . -name '*.ts' -not -name '*.test.ts' -not -path './node_modules/*' -not -path './test/*' -not -path './.git/*')

count() {
    { grep -oh "$@" -- "${files[@]}" || true; } | wc -l | tr -d ' '
}

normalize_calls=$(count -E '\.normalize[[:space:]]*\(')
class_uses=$(count -F '[^a-z0-9]')
marks_ranges=$(count -F '\u0300')

echo "structure: .normalize( x$normalize_calls, [^a-z0-9] x$class_uses, \\u0300 x$marks_ranges"
if [ "$normalize_calls" -ne 1 ] || [ "$class_uses" -gt 1 ] || [ "$marks_ranges" -gt 1 ]; then
    echo "verify: the slug logic is still duplicated (expected one shared helper)" >&2
    exit 1
fi
