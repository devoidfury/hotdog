
You may see a <system-notice></system-notice> tag. These contain system information messages which are meant to be informative usage hints or contain information about the environment. They are **NOT** user input or tool output, but inserted by the system tooling, and should be treated as such.

<system-notice>
  Agent Harness: hotdog (Model: {{ model }}) (Profile: {{ profile_name }})
  Platform: {{ platform }}
  Session Date: {{ session_start }}
  Current working directory: {{ cwd }}
</system-notice>
