/**
 * Home card for the unified RF Studio Bot.
 * Shows all three capabilities and lets the user pick one.
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
                    text: "🎴 Deck Builder",
                    weight: "Bolder",
                    wrap: true,
                  },
                  {
                    type: "TextBlock",
                    text: "Build custom pitch decks from Canva templates",
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
                    text: "📁 Project Provisioner",
                    weight: "Bolder",
                    wrap: true,
                  },
                  {
                    type: "TextBlock",
                    text: "Spin up a new project across Dropbox, Frame.io, Canva, OneDrive, Clockify, Figma, Notion & Teams",
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
                    text: "🎬 Script → Storyboard",
                    weight: "Bolder",
                    wrap: true,
                  },
                  {
                    type: "TextBlock",
                    text: "Parse scripts into scenes and provision storyboards across Boords, ElevenLabs, Figma & FigJam",
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
        title: "🎴  Build a Deck",
        data: { action: "startDeck" },
      },
      {
        type: "Action.Submit",
        title: "📁  New Project",
        data: { action: "startProvisioner" },
      },
      {
        type: "Action.Submit",
        title: "🎬  Storyboard",
        data: { action: "startStoryboard" },
      },
    ],
  };
}
