/**
 * Adaptive Card builders for the Teams bot deck-building wizard.
 * Each function returns a card JSON object (Adaptive Card schema v1.5).
 */

/**
 * Card 1: Page Selection — checkboxes for intro pages and project groups.
 * Locked pages shown as non-interactive text (always included).
 */
export function buildPageSelectionCard(locked, intros, projectGroups, preSelectedIntros, preSelectedProjects) {
  const body = [
    {
      type: "TextBlock",
      text: "Build Your Deck",
      size: "Large",
      weight: "Bolder",
    },
    {
      type: "TextBlock",
      text: "Select the pages to include in your capabilities deck.",
      isSubtle: true,
      wrap: true,
    },
  ];

  // Locked pages (always included, non-interactive)
  if (locked.length > 0) {
    body.push({
      type: "TextBlock",
      text: "ALWAYS INCLUDED",
      weight: "Bolder",
      size: "Small",
      spacing: "Medium",
      color: "Accent",
    });
    for (const p of locked) {
      body.push({
        type: "TextBlock",
        text: `\u{1F512} ${p.label}`,
        isSubtle: true,
        spacing: "None",
      });
    }
  }

  // Intro pages (multi-select checkboxes)
  if (intros.length > 0) {
    body.push({
      type: "TextBlock",
      text: "INTRO PAGES",
      weight: "Bolder",
      size: "Small",
      spacing: "Medium",
      color: "Accent",
    });
    body.push({
      type: "Input.ChoiceSet",
      id: "selectedIntros",
      isMultiSelect: true,
      style: "expanded",
      value: preSelectedIntros || "",
      choices: intros.map((p) => ({
        title: p.label,
        value: p.id,
      })),
    });
  }

  // Project groups (multi-select checkboxes)
  if (projectGroups.length > 0) {
    body.push({
      type: "TextBlock",
      text: "PROJECTS",
      weight: "Bolder",
      size: "Small",
      spacing: "Medium",
      color: "Accent",
    });
    body.push({
      type: "Input.ChoiceSet",
      id: "selectedProjects",
      isMultiSelect: true,
      style: "expanded",
      value: preSelectedProjects || "",
      choices: projectGroups.map((g) => ({
        title: `${g.displayName} (${g.pages.length} page${g.pages.length > 1 ? "s" : ""})`,
        value: g.groupKey,
      })),
    });
  }

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body,
    actions: [
      {
        type: "Action.Submit",
        title: "Continue to Cover \u2192",
        data: { action: "selectPages" },
      },
    ],
  };
}

/**
 * Card 2: Cover Info — text inputs for client name, author, deck name, and date.
 * @param {string} teamName
 * @param {object} [prefill] — pre-filled cover values (for Back navigation)
 * @param {object} [selections] — { selectedIntroIds, selectedProjectKeys, selectedIds }
 *        Embedded in action data to survive KV eventual-consistency across CF edges.
 */
export function buildCoverInfoCard(teamName, prefill, selections) {
  const pf = prefill || {};
  const sel = selections || {};

  // Carry selection state through the card actions (avoids KV propagation issues)
  const carry = {
    _selectedIntroIds: sel.selectedIntroIds || "",
    _selectedProjectKeys: sel.selectedProjectKeys || "",
    _selectedIds: sel.selectedIds || "",
  };

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body: [
      {
        type: "TextBlock",
        text: "Customize Cover",
        size: "Large",
        weight: "Bolder",
      },
      {
        type: "TextBlock",
        text: "Personalize the deck for your client.",
        isSubtle: true,
        wrap: true,
      },
      // Author
      {
        type: "TextBlock",
        text: "Your Name",
        weight: "Bolder",
        size: "Small",
        spacing: "Medium",
      },
      {
        type: "Input.Text",
        id: "author",
        placeholder: "e.g. Sarah",
        value: pf.author || "",
      },
      // Deck name
      {
        type: "TextBlock",
        text: "Deck Name",
        weight: "Bolder",
        size: "Small",
        spacing: "Medium",
      },
      {
        type: "Input.Text",
        id: "deckName",
        placeholder: `${teamName || "R&F"} \u2014 Client Name`,
        value: pf.deckName || "",
      },
      // Client name
      {
        type: "TextBlock",
        text: "Client / Recipient Name",
        weight: "Bolder",
        size: "Small",
        spacing: "Medium",
      },
      {
        type: "Input.Text",
        id: "clientName",
        placeholder: "e.g. Acme Corp",
        value: pf.clientName || "",
      },
      // Cover date
      {
        type: "TextBlock",
        text: "Cover Date",
        weight: "Bolder",
        size: "Small",
        spacing: "Medium",
      },
      {
        type: "Input.Date",
        id: "coverDate",
        value: pf.coverDate || new Date().toISOString().split("T")[0],
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "\u2190 Back",
        data: { action: "backToSelect", ...carry },
      },
      {
        type: "Action.Submit",
        title: "Review & Generate \u2192",
        data: { action: "coverInfo", ...carry },
      },
    ],
  };
}

/**
 * Card 3: Review — summary of selections with a Generate button.
 * @param {object} summary — display data for the review
 * @param {object} [stateCarry] — full state to embed in action data
 *        { selectedIntroIds, selectedProjectKeys, selectedIds,
 *          author, deckName, clientName, coverDate }
 */
export function buildReviewCard(summary, stateCarry) {
  const sc = stateCarry || {};

  // Carry ALL state through the action buttons (avoids KV propagation issues)
  const carry = {
    _selectedIntroIds: sc.selectedIntroIds || "",
    _selectedProjectKeys: sc.selectedProjectKeys || "",
    _selectedIds: sc.selectedIds || "",
    _author: sc.author || "",
    _deckName: sc.deckName || "",
    _clientName: sc.clientName || "",
    _coverDate: sc.coverDate || "",
  };

  const body = [
    {
      type: "TextBlock",
      text: "Review & Generate",
      size: "Large",
      weight: "Bolder",
    },
    {
      type: "FactSet",
      facts: [
        { title: "Deck Name", value: summary.deckName || "(auto)" },
        { title: "Client", value: summary.clientName || "(default)" },
        { title: "Author", value: summary.author || "(anonymous)" },
        { title: "Cover Date", value: summary.coverDate || "(none)" },
        { title: "Total Pages", value: String(summary.pageCount) },
        { title: "Projects", value: String(summary.projectCount) },
      ],
    },
  ];

  if (summary.projects && summary.projects.length > 0) {
    body.push({
      type: "TextBlock",
      text: "Selected Work:",
      weight: "Bolder",
      size: "Small",
      spacing: "Medium",
    });
    for (const p of summary.projects) {
      body.push({
        type: "TextBlock",
        text: `\u2022 ${p.client ? p.client + " \u2014 " : ""}${p.project}`,
        wrap: true,
        spacing: "None",
      });
    }
  }

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body,
    actions: [
      {
        type: "Action.Submit",
        title: "\u2190 Back",
        data: { action: "backToCover", ...carry },
      },
      {
        type: "Action.Submit",
        title: "\u{1F680} Generate Deck",
        data: { action: "generate", ...carry },
        style: "positive",
      },
    ],
  };
}

/**
 * Card 4: Result — success with links to the generated deck.
 */
export function buildResultCard(result) {
  // Build the direct Canva design URL for sharing/publishing
  const canvaDesignUrl = `https://www.canva.com/design/${result.designId}/view`;

  const body = [
    {
      type: "TextBlock",
      text: "\u2705 Deck Created!",
      size: "Large",
      weight: "Bolder",
      color: "Good",
    },
    {
      type: "TextBlock",
      text: `**${result.deckName}** \u2014 ${result.pageCount} pages`,
      wrap: true,
    },
    {
      type: "FactSet",
      spacing: "Small",
      facts: [
        { title: "Canva Link", value: canvaDesignUrl },
      ],
    },
    {
      type: "TextBlock",
      text: "To publish as a website: open in Canva \u2192 Share \u2192 More \u2192 Website",
      isSubtle: true,
      wrap: true,
      size: "Small",
      spacing: "Small",
    },
  ];

  const actions = [
    {
      type: "Action.OpenUrl",
      title: "\u270F\uFE0F Edit in Canva",
      url: result.editUrl,
    },
    {
      type: "Action.OpenUrl",
      title: "\u{1F310} View / Publish",
      url: canvaDesignUrl,
    },
  ];

  actions.push({
    type: "Action.Submit",
    title: "Build Another Deck",
    data: { action: "newDeck" },
  });

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body,
    actions,
  };
}
