/**
 * Adaptive Card builders for the Project Provisioner bot.
 * - Intake form card (sent when user says "new project")
 * - Summary card (sent after provisioning completes)
 */

// -- Service display config --

const SERVICE_ROWS = [
  { key: "dropbox", displayName: "Dropbox", emoji: "\ud83d\udce6" },
  { key: "frameio", displayName: "Frame.io", emoji: "\ud83c\udfac" },
  { key: "canva", displayName: "Canva", emoji: "\ud83c\udfa8" },
  { key: "onedrive", displayName: "OneDrive", emoji: "\u2601\ufe0f" },
  { key: "clockify", displayName: "Clockify", emoji: "\u23f1\ufe0f" },
  { key: "notion", displayName: "Notion", emoji: "\ud83d\udcd3" },
  { key: "teams", displayName: "Teams Chat", emoji: "\ud83d\udcac" },
];

const SERVICE_EMOJI = {
  dropbox: "\ud83d\udce6 Dropbox",
  frameio: "\ud83c\udfac Frame.io",
  canva: "\ud83c\udfa8 Canva",
  onedrive: "\u2601\ufe0f OneDrive",
  clockify: "\u23f1\ufe0f Clockify",
  notion: "\ud83d\udcd3 Notion",
  teams: "\ud83d\udcac Teams Chat",
};

export { SERVICE_EMOJI };

/**
 * Build the project intake form Adaptive Card.
 * This is the same card as src/bot/adaptiveCard.json but constructed in JS.
 */
export function buildIntakeCard() {
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "\ud83c\udfac New Project Provisioner",
        weight: "Bolder",
        size: "Large",
        wrap: true,
      },
      {
        type: "TextBlock",
        text: "Fill out this form to automatically provision your project across all platforms.",
        wrap: true,
        spacing: "None",
        isSubtle: true,
      },
      {
        type: "TextBlock",
        text: "PROJECT DETAILS",
        weight: "Bolder",
        size: "Medium",
        spacing: "Large",
        separator: true,
      },
      {
        type: "Input.Text",
        id: "projectName",
        label: "Project Name",
        placeholder: "e.g. Brand Launch Video 2025",
        isRequired: true,
        errorMessage: "Project name is required",
      },
      {
        type: "Input.Text",
        id: "clientName",
        label: "Client Name",
        placeholder: "e.g. Acme Corp",
        isRequired: true,
        errorMessage: "Client name is required",
      },
      {
        type: "Input.ChoiceSet",
        id: "projectType",
        label: "Project Type",
        value: "Brand Video",
        choices: [
          { title: "Brand Video", value: "Brand Video" },
          { title: "Motion Graphics", value: "Motion Graphics" },
          { title: "Social Campaign", value: "Social Campaign" },
          { title: "Explainer", value: "Explainer" },
          { title: "Broadcast", value: "Broadcast" },
          { title: "Other", value: "Other" },
        ],
        style: "compact",
      },
      {
        type: "Input.Text",
        id: "projectManager",
        label: "Project Manager (email)",
        placeholder: "pm@company.com",
        isRequired: true,
        errorMessage: "Project manager email is required",
        style: "Email",
      },
      {
        type: "Input.Text",
        id: "teamMembers",
        label: "Team Members (comma-separated emails)",
        placeholder: "editor@company.com, designer@company.com",
      },
      {
        type: "ColumnSet",
        columns: [
          {
            type: "Column",
            width: "stretch",
            items: [
              {
                type: "Input.Date",
                id: "startDate",
                label: "Start Date",
              },
            ],
          },
          {
            type: "Column",
            width: "stretch",
            items: [
              {
                type: "Input.Date",
                id: "deadline",
                label: "Deadline",
              },
            ],
          },
        ],
      },
      {
        type: "Input.Text",
        id: "description",
        label: "Description",
        placeholder: "Brief project description...",
        isMultiline: true,
      },
      {
        type: "TextBlock",
        text: "SERVICES TO PROVISION",
        weight: "Bolder",
        size: "Medium",
        spacing: "Large",
        separator: true,
      },
      {
        type: "TextBlock",
        text: "Uncheck any platforms you don't need for this project.",
        wrap: true,
        spacing: "None",
        isSubtle: true,
      },
      {
        type: "ColumnSet",
        spacing: "Medium",
        columns: [
          {
            type: "Column",
            width: "stretch",
            items: [
              { type: "Input.Toggle", id: "svc_dropbox", title: "\ud83d\udce6 Dropbox", value: "true", valueOn: "true", valueOff: "false" },
              { type: "Input.Toggle", id: "svc_frameio", title: "\ud83c\udfac Frame.io", value: "true", valueOn: "true", valueOff: "false" },
              { type: "Input.Toggle", id: "svc_onedrive", title: "\u2601\ufe0f OneDrive", value: "true", valueOn: "true", valueOff: "false" },
              { type: "Input.Toggle", id: "svc_clockify", title: "\u23f1\ufe0f Clockify", value: "true", valueOn: "true", valueOff: "false" },
            ],
          },
          {
            type: "Column",
            width: "stretch",
            items: [
              { type: "Input.Toggle", id: "svc_canva", title: "\ud83c\udfa8 Canva", value: "true", valueOn: "true", valueOff: "false" },
              { type: "Input.Toggle", id: "svc_notion", title: "\ud83d\udcd3 Notion", value: "true", valueOn: "true", valueOff: "false" },
              { type: "Input.Toggle", id: "svc_teams", title: "\ud83d\udcac Teams Chat", value: "true", valueOn: "true", valueOff: "false" },
            ],
          },
        ],
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "\ud83d\ude80 Provision Project",
        style: "positive",
        data: {
          action: "provisionProject",
        },
      },
    ],
  };
}

/**
 * Build a service status row for the summary card.
 */
function buildServiceRow(config, result) {
  const { displayName, emoji } = config;

  if (!result || (!result.success && result.error === "skipped")) {
    return {
      type: "ColumnSet",
      columns: [
        {
          type: "Column",
          width: "auto",
          items: [{ type: "TextBlock", text: `${emoji} ${displayName}`, wrap: true }],
        },
        {
          type: "Column",
          width: "stretch",
          items: [
            {
              type: "TextBlock",
              text: "\u23ed\ufe0f Not provisioned",
              wrap: true,
              isSubtle: true,
            },
          ],
        },
      ],
    };
  }

  if (result.success && result.url) {
    const linkText = result.note
      ? `[${result.note} \u2197](${result.url})`
      : `[Open \u2197](${result.url})`;
    return {
      type: "ColumnSet",
      columns: [
        {
          type: "Column",
          width: "auto",
          items: [{ type: "TextBlock", text: `${emoji} ${displayName}`, wrap: true }],
        },
        {
          type: "Column",
          width: "stretch",
          items: [
            {
              type: "TextBlock",
              text: linkText,
              wrap: true,
              color: "Good",
            },
          ],
        },
      ],
    };
  }

  // Failed — include error detail for debugging
  const errorDetail = result.error ? `: ${result.error.substring(0, 120)}` : "";
  return {
    type: "ColumnSet",
    columns: [
      {
        type: "Column",
        width: "auto",
        items: [{ type: "TextBlock", text: `${emoji} ${displayName}`, wrap: true }],
      },
      {
        type: "Column",
        width: "stretch",
        items: [
          {
            type: "TextBlock",
            text: `\u26a0\ufe0f Failed${errorDetail}`,
            wrap: true,
            color: "Attention",
            size: "Small",
          },
        ],
      },
    ],
  };
}

/**
 * Build the final summary Adaptive Card showing provisioning results.
 * @param {string} projectName
 * @param {string} clientName
 * @param {object} results - ProvisioningResults keyed by service
 * @param {Set<string>} selectedServices
 */
export function buildSummaryCard(projectName, clientName, results, selectedServices) {
  let successCount = 0;
  let failureCount = 0;
  let selectedCount = 0;

  for (const row of SERVICE_ROWS) {
    const result = results[row.key];
    if (!result || (!result.success && result.error === "skipped")) continue;
    selectedCount++;
    if (result.success) {
      successCount++;
    } else {
      failureCount++;
    }
  }

  const allGood = failureCount === 0 && selectedCount > 0;
  const badgeText = allGood ? "\u2705 All Systems Go" : "\u26a0\ufe0f Partial Success";
  const badgeColor = allGood ? "Good" : "Attention";

  const serviceRows = SERVICE_ROWS.map((config) =>
    buildServiceRow(config, results[config.key])
  );

  const body = [
    {
      type: "TextBlock",
      text: `\ud83c\udfac ${projectName} \u2014 ${clientName}`,
      weight: "Bolder",
      size: "Large",
      wrap: true,
    },
    {
      type: "TextBlock",
      text: badgeText,
      color: badgeColor,
      weight: "Bolder",
      size: "Medium",
      spacing: "Small",
    },
    {
      type: "FactSet",
      facts: [
        { title: "Services", value: `${successCount} of ${selectedCount} services provisioned` },
      ],
      spacing: "Small",
    },
    {
      type: "TextBlock",
      text: "SERVICE STATUS",
      weight: "Bolder",
      spacing: "Large",
      separator: true,
    },
    ...serviceRows,
  ];

  const actions = [];

  // Add Notion button only if Notion URL exists
  if (results.notion?.success && results.notion.url) {
    actions.push({
      type: "Action.OpenUrl",
      title: "\ud83d\udcd3 View Notion Page",
      url: results.notion.url,
      style: "positive",
    });
  }

  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body,
    actions,
  };
}
