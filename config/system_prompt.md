{{ role }}

{% if body -%}
{{ body }}
{% endif -%}
{%- for chunk in chunks -%}
{{ chunk.content }}
{%- endfor -%}
