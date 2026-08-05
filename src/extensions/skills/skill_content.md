<skill_content name="{{ skill.name }}">
{{ skill.content }}

Skill directory: {{ skill.location }}
Relative paths in this skill are relative to the skill directory.
{% if skill.additional_files|length > 0 %}

<skill_resources>
{% for file in skill.additional_files -%}
  <file>{{ file }}</file>
{% endfor %}
</skill_resources>
{% endif %}
</skill_content>
