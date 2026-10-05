tokens/*.txt are byte-exact copies of `evals/control-tokens/*.txt` (one control
token per line, harvested from 70 real chat templates; see the INVENTORY files
in the source dir). Refresh after any change to the source:

    cp evals/control-tokens/*.txt evals/series/kielbasa-2/tasks/fixture-token-landmines/tokens/

The expected WARN/OK counts in the task checks derive from the line count
(515 lines: every 4th line OK, rest WARN -> WARN=387 OK=128). If you refresh
the tokens, recount and update 011-token-landmines.json accordingly.
