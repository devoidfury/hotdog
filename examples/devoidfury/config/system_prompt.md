{{ role }}
{%- if body %}
{{ body }}
{%- endif %}
Use parallel tool calls when appropriate.

{% for chunk in chunks -%}
{{ chunk.content }}
{%- endfor -%}
