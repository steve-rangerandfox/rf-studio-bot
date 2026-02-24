/**
 * Page parsing and grouping logic — shared between web frontend API and Teams bot.
 * Ported from src/App.jsx parsePage() and groupPages().
 */

export function parsePage(p) {
  const m = p.title.match(/^(locked|intro|project):\s*(.+)$/i);
  if (!m) return { type: "intro", label: p.title, id: p.id, thumbnail: p.thumbnail };
  const type = m[1].toLowerCase();
  const label = m[2].trim();
  if (type === "project") {
    // Try client|project with optional page number
    const pipeMatch = label.match(/^(.+?)\s*\|\s*(.+?)(?:\s+(\d+))?$/);
    if (pipeMatch) {
      const client = pipeMatch[1].trim();
      const projName = pipeMatch[2].trim();
      const pageNum = pipeMatch[3] ? +pipeMatch[3] : 1;
      const displayName = `${client} ${projName}`;
      const groupKey = displayName.toLowerCase();
      return { type, label, client, projectName: projName, displayName, groupKey, pageNum, id: p.id, thumbnail: p.thumbnail };
    }
    // No pipe — try just a number suffix
    const nm = label.match(/^(.+?)\s+(\d+)$/);
    if (nm) return { type, label, client: "", projectName: nm[1], displayName: nm[1], groupKey: nm[1].toLowerCase(), pageNum: +nm[2], id: p.id, thumbnail: p.thumbnail };
    return { type, label, client: "", projectName: label, displayName: label, groupKey: label.toLowerCase(), pageNum: 1, id: p.id, thumbnail: p.thumbnail };
  }
  return { type, label, id: p.id, thumbnail: p.thumbnail };
}

export function groupPages(rawPages) {
  const locked = [];
  const intros = [];
  const projectMap = new Map();

  for (const rp of rawPages) {
    const p = parsePage(rp);
    if (p.type === "locked") { locked.push(p); continue; }
    if (p.type === "intro") { intros.push(p); continue; }
    if (!projectMap.has(p.groupKey)) {
      projectMap.set(p.groupKey, { displayName: p.displayName, client: p.client || "", projectName: p.projectName || p.displayName, groupKey: p.groupKey, pages: [] });
    }
    projectMap.get(p.groupKey).pages.push(p);
  }

  for (const g of projectMap.values()) {
    g.pages.sort((a, b) => a.pageNum - b.pageNum);
  }

  return { locked, intros, projectGroups: [...projectMap.values()] };
}

/**
 * Compute Selected Work entries (top-filled, no padding).
 * Returns only the actual selected projects — the PPTX replacement
 * module handles blanking any extra master entries.
 * @param {Array} selectedProjectGroups — array of project group objects with .client and .projectName
 * @returns {Array<{client:string, project:string}>} selected projects, top-filled
 */
export function computeSelectedWork(selectedProjectGroups) {
  return selectedProjectGroups.map((g) => ({ client: g.client, project: g.projectName }));
}
