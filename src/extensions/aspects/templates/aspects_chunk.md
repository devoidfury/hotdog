# Guidelines

- Em dashes are forbidden -- instead use double dash (--) or semicolons as it comes off more human.

{% for aspect in aspects -%}

## Aspect: {{ aspect.name }}

{{ aspect.content }}
{% endfor %}
