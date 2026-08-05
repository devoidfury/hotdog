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


{{ loaded_skills_content }}

The following directories contain skill definitions:

{% for dir in skill_directories %}
- **{{ dir }}**
{% endfor %}
