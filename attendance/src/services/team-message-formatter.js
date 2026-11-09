function teamLabel(category) {
  if (!category?.name?.trim()) return null;
  const name = category.name.trim();
  const parentName = category.parent?.name?.trim();
  return parentName ? `${parentName}: ${name}` : name;
}

function formatTeamMessage(category, content = "") {
  const team = teamLabel(category);
  if (!team) return content;
  const label = `*[${team}]*`;
  return `${label}${content ? `\n\n${content}` : ""}`;
}

module.exports = { formatTeamMessage, teamLabel };
