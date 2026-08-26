{{ role }}
{%- if body %}
{{ body }}
{%- endif %}
Parallel tool calling enabled.

{% for chunk in chunks -%}
{{ chunk.content }}
{% endfor -%}
