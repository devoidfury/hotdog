# Role & Mission

{{ role }}

Use the instructions below and the tools available to you to assist the user.

{%- if body %}

{{ body }}
{% endif -%}{%- for chunk in chunks -%}
{{ chunk.content }}
{%- endfor -%}
