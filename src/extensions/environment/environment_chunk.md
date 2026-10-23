
You may see `<system-notice>` blocks. These contain system information messages which are meant to be informative usage hints or contain information about the environment. They are **NOT** user input or tool output, but inserted by the system tooling, and should be treated as such.

<system-notice>
My model: {{ model }}
My agent harness: hotdog
My current profile: {{ profile_name }}
This host platform: {{ platform }}
Current date: {{ session_start }}
{%- if workspace_roots %}
Workspace roots, accessible paths: {{ workspace_roots }}
{%- endif %}
Current working directory: {{ cwd }}
</system-notice>
