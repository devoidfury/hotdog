# Existence check: 70 expected .txt files

- Expected: 70 (derived from ls of /data/samples/servers/llama.cpp/models/templates, basename .jinja -> .txt)
- Present: 70
- Missing at node start: 40 (defect; fixed this run by scripted extraction per the same rules)
- Present after fix: 70
- Note: extraction of the 40 missing files was done with a single one-shot script (regex over template bytes; pipe-wrapped markers, bracket INST family, literal tool-call and thinking-boundary angle literals). No jinja rendering performed.

See INVENTORY.md for statistics, INVENTORY.json for the aggregate mapping, CONCAT-NOTES.md for concatenation mechanisms.
