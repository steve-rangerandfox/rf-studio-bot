/**
 * Home card for the unified RF Studio Bot.
 * Shows both capabilities and lets the user pick one.
 */

export function buildHomeCard() {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "RF Studio Bot",
        size: "Large",
        weight: "Bolder",
        wrap: true,
      },
      {
        type: "TextBlock",
        text: "What would you like to do?",
        spacing: "Small",
        wrap: true,
      },
      {
        type: "ColumnSet",
        spacing: "Medium",
        columns: [
          {
            type: "Column",
            width: "stretch",
            items: [
              {
                type: "Container",
                style: "emphasis",
                bleed: false,
                items: [
                  {
                    type: "TextBlock",
                    text: "\ud83d\udcc1 Project Provisioner",
                    weight: "Bolder",
                    wrap: true,
                  },
                  {
                    type: "TextBlock",
                    text: "Spin up a new project across Dropbox, Frame.io, OneDrive, Clockify, Notion & Teams",
                    size: "Small",
                    wrap: true,
                    spacing: "Small",
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "ColumnSet",
        spacing: "Small",
        columns: [
          {
            type: "Column",
            width: "stretch",
            items: [
              {
                type: "Container",
                style: "emphasis",
                bleed: false,
                items: [
                  {
                    type: "TextBlock",
                    text: "\ud83c\udfac Script \u2192 Storyboard",
                    weight: "Bolder",
                    wrap: true,
                  },
                  {
                    type: "TextBlock",
                    text: "Parse scripts into scenes and provision storyboards across Boords & ElevenLabs",
                    size: "Small",
                    wrap: true,
                    spacing: "Small",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "\ud83d\udcc1  New Project",
        data: { action: "startProvisioner" },
      },
      {
        type: "Action.Submit",
        title: "\ud83c\udfac  Storyboard",
        data: { action: "startStoryboard" },
      },
    ],
  };
}
