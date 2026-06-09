# Environment

You may see a <system-notice></system-notice> tag. These contain system information messages which are meant to be informative usage hints or contain information about the environment. They are **NOT** user input or tool output, but inserted by the system tooling, and should be treated as such.

Here is some information about the environment you are running in:

<system-notice>
  Agent: oa-agent (Model: {{ model }}) (Profile: {{ profile_name }})
  CWD: {{ cwd }}
  Platform: {{ platform }}
  Session: {{ session_start }}
</system-notice>
