#!/usr/bin/env bash
# Checks that each eval task is well-formed:
#   - task.md, repo/, hidden/, verify.sh, meta.json and solution.patch exist, and
#     meta.json has a valid id, category, language and smoke flag;
#   - task.md does not mention the hidden tests; repo/ stays under 25,000 bytes;
#   - the starting repo, with hidden/ copied in, FAILS verify.sh;
#   - the starting repo plus solution.patch, with hidden/ copied in, PASSES verify.sh;
#   - each verify.sh run takes under 60 s;
#   - the visible tests, run as shipped, pass for refactors and fail for
#     02-ts-cross-file-bug (the task starts from a failing test); for the other
#     tasks the result is only recorded.
#
# Usage: eval/check-tasks.sh [task-id ...]    KEEP=1 keeps the temp workspaces.
# Needs only bash, git, python3 and bun.
set -uo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
tasks_dir="$root/tasks"
work="$(mktemp -d "${TMPDIR:-/tmp}/heyho-check.XXXXXX")"
if [ "${KEEP:-0}" = 1 ]; then
    echo "workspaces kept in $work"
else
    trap 'rm -rf "$work"' EXIT
fi

ids=("$@")
if [ ${#ids[@]} -eq 0 ]; then
    for dir in "$tasks_dir"/*/; do
        ids+=("$(basename "$dir")")
    done
fi

fresh_copy() {
    mkdir -p "$2" &&
        cp -R "$1/repo/." "$2/" &&
        (cd "$2" && git init -q && git add -A &&
            git -c user.name=eval -c user.email=eval@localhost commit -qm init)
}

# run_logged DIR LOG CMD... : run CMD inside DIR, output to LOG, return its status.
run_logged() {
    local dir=$1 log=$2
    shift 2
    (cd "$dir" && PYTHONDONTWRITEBYTECODE=1 "$@") >"$log" 2>&1
}

malformed=0
for id in "${ids[@]}"; do
    task="$tasks_dir/$id"
    w="$work/$id"
    mkdir -p "$w"
    problems=()
    unsolved="-"
    solved="-"
    visible="-"
    elapsed="-"

    for name in task.md repo hidden verify.sh meta.json solution.patch; do
        [ -e "$task/$name" ] || problems+=("missing $name")
    done

    if [ ${#problems[@]} -eq 0 ]; then
        meta=$(python3 - "$task/meta.json" "$id" <<'PY'
import json, sys
meta = json.load(open(sys.argv[1]))
valid = (
    meta.get("id") == sys.argv[2]
    and meta.get("category") in ("bugfix", "feature", "refactor")
    and meta.get("language") in ("python", "typescript")
    and isinstance(meta.get("smoke"), bool)
)
if not valid:
    sys.exit(1)
print(meta["category"], meta["language"])
PY
        ) || problems+=("meta.json is invalid")
    fi

    if [ ${#problems[@]} -eq 0 ]; then
        read -r category language <<<"$meta"

        if grep -qi 'hidden' "$task/task.md"; then
            problems+=("task.md mentions the hidden tests")
        fi
        size=$(find "$task/repo" -type f -exec cat {} + | wc -c | tr -d ' ')
        if [ "$size" -gt 25000 ]; then
            problems+=("repo/ is $size bytes (limit 25000)")
        fi

        if [ "$language" = python ]; then
            visible_cmd=(python3 -m unittest discover -s tests)
        else
            visible_cmd=(bun test)
        fi
        expected_visible=""
        [ "$category" = refactor ] && expected_visible=pass
        [ "$id" = 02-ts-cross-file-bug ] && expected_visible=fail

        fresh_copy "$task" "$w/visible"
        if run_logged "$w/visible" "$w/visible.log" "${visible_cmd[@]}"; then
            visible=pass
        else
            visible=fail
        fi
        if [ -n "$expected_visible" ]; then
            if [ "$visible" = "$expected_visible" ]; then
                visible="$visible(ok)"
            else
                problems+=("visible tests should $expected_visible but ${visible}ed; see $w/visible.log")
                visible="$visible(BAD)"
            fi
        fi

        fresh_copy "$task" "$w/unsolved"
        cp -R "$task/hidden/." "$w/unsolved/"
        start=$SECONDS
        if run_logged "$w/unsolved" "$w/unsolved.log" bash "$task/verify.sh"; then
            unsolved="PASS(BAD)"
            problems+=("verify.sh passes on the unsolved repo; see $w/unsolved.log")
        else
            unsolved="FAIL(ok)"
        fi
        unsolved_time=$((SECONDS - start))

        fresh_copy "$task" "$w/solved"
        solved_time=0
        if (cd "$w/solved" && git apply "$task/solution.patch") >"$w/apply.log" 2>&1; then
            cp -R "$task/hidden/." "$w/solved/"
            start=$SECONDS
            if run_logged "$w/solved" "$w/solved.log" bash "$task/verify.sh"; then
                solved="PASS(ok)"
            else
                solved="FAIL(BAD)"
                problems+=("verify.sh fails with solution.patch; see $w/solved.log")
            fi
            solved_time=$((SECONDS - start))
        else
            solved="NOAPPLY(BAD)"
            problems+=("solution.patch does not apply: $(head -1 "$w/apply.log")")
        fi

        elapsed="${unsolved_time}s/${solved_time}s"
        if [ "$unsolved_time" -ge 60 ] || [ "$solved_time" -ge 60 ]; then
            problems+=("verify.sh took $elapsed (limit 60 s)")
        fi
    fi

    printf '%-26s unsolved=%-10s solved=%-12s visible=%-10s verify-time=%s\n' \
        "$id" "$unsolved" "$solved" "$visible" "$elapsed"
    if [ ${#problems[@]} -gt 0 ]; then
        malformed=1
        for problem in "${problems[@]}"; do
            echo "    MALFORMED: $problem"
        done
    fi
done

if [ "$malformed" -ne 0 ]; then
    echo "some tasks are malformed (rerun with KEEP=1 to inspect the workspaces)"
    exit 1
fi
echo "all ${#ids[@]} tasks OK"
