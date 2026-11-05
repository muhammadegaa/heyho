# logsum

Summarise application logs from the command line.

Each log line looks like:

```
2024-03-10T09:30:00Z ERROR [db] connection reset by peer
```

```
python3 -m logsum app.log worker.log         # count entries per level
python3 -m logsum --by component app.log      # ... per component
python3 -m logsum --by message --top 5 app.log
python3 -m logsum --level warning --format json app.log
cat app.log | python3 -m logsum
```

Options:

| option | meaning |
|---|---|
| `--level LEVEL` | ignore entries below LEVEL (DEBUG, INFO, WARNING, ERROR, CRITICAL) |
| `--by {level,component,message}` | what to group by; `message` groups messages that differ only in numbers or ids |
| `--top N` | show only the N largest groups (the total still counts every entry) |
| `--format {text,json}` | output format |

Lines that are not log entries are counted as `skipped`.

Run the tests with `python3 -m unittest discover -s tests`.
