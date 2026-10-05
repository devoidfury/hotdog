MiniMax-M2.jinja: tool-call begin and end markers are held in template variables and emitted only through variable references, so the rendered marker exists only after rendering
MiniMax-M3.jinja: role-turn open marker is assembled by concatenating a fixed prefix literal with a role name chosen at render time; additionally tool-call begin/end markers live in template variables referenced at emit points
NVIDIA-Nemotron-3-Nano-30B-A3B-BF16.jinja: a pipe-wrapped turn delimiter is assembled by concatenating its opening half, the message role, and its closing half as three separate string literals
NousResearch-Hermes-2-Pro-Llama-3-8B-tool_use.jinja: pipe-wrapped turn delimiters are assembled by concatenating an opening half literal, the message role, and a closing half literal
NousResearch-Hermes-3-Llama-3.1-8B-tool_use.jinja: pipe-wrapped turn delimiters are assembled by concatenating an opening half literal, the message role, and a closing half literal
Qwen-QwQ-32B.jinja: pipe-wrapped turn delimiters are assembled by concatenating an opening half literal, the message role, and a closing half literal
Qwen-Qwen2.5-7B-Instruct.jinja: pipe-wrapped turn delimiters are assembled by concatenating an opening half literal, the message role, and a closing half literal
Qwen-Qwen3-0.6B.jinja: pipe-wrapped turn delimiters are assembled by concatenating an opening half literal, the message role, and a closing half literal
Qwen3-Coder.jinja: pipe-wrapped turn delimiters are assembled by concatenating an opening half literal, the message role, and a closing half literal
Qwen3.5-4B.jinja: pipe-wrapped turn delimiters are assembled by concatenating an opening half literal, the message role, and a closing half literal
Spark2.5.jinja: pipe-wrapped turn delimiters are assembled by concatenating an opening half literal, the message role, and a closing half literal
StepFun3.5-Flash.jinja: pipe-wrapped turn delimiters are assembled by concatenating an opening half literal, the message role, and a closing half literal
deepseek-ai-DeepSeek-V3.1.jinja: tool-call begin/end markers are built inside Jinja macros by concatenating an open-angle bracket literal, a fixed marker word, and a close-bracket literal in separate fragments
deepseek-ai-DeepSeek-V3.2.jinja: namespaced tool-tag markers are assembled by concatenating a bracket character literal with a template variable holding the namespace marker; thinking boundary tokens are set in variables and emitted through variable references
deepseek-ai-DeepSeek-V4-Flash-0731.jinja: namespaced tool-tag markers are assembled by concatenating a bracket character literal with a template variable holding the namespace marker; thinking boundary tokens are set in variables and emitted through variable references
