# Safer Tool Sets

In ./profiles, there are a couple example profiles that restrict tools to read-only and by domain.

For example, one configuration can read your files but can't exfiltrate data as the agent has no network access; and an internet-connected profile for searching the web that can't read any files.

Copy these into your config/profiles and use them with the --profile <name> flag.

These are generally safer to use and good candidates for use outside of a dedicated host/vm/container/etc.
