# Available Skills

You have skills available which provide information, guidelines, and workflows for completing tasks.

Use the `load_skill` tool to load the full instructions for a skill when you need it.

<available_skills>
{% for skill in skills -%}{% if not skill.loaded %}
<skill>
  <name>{{ skill.name }}</name>
  <description>{{ skill.description }}</description>
  <location>{{ skill.location }}</location>
</skill>
{% endif %}{% endfor %}
</available_skills>


{% for skill in skills -%}{% if skill.loaded %}
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
{% endif -%}
{% endfor %}

The following directories contain skill definitions:

{% for dir in skill_directories %}
- **{{ dir }}**
{% endfor %}
