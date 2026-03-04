/**
 * Adaptive Card templates for the Script-to-Storyboard bot.
 * Exported as plain JS objects (no external JSON files needed).
 */

import { VOICES } from "./voices.js";

/**
 * Builds the upload prompt card with voice choices populated from config.
 */
export function buildUploadPromptCard() {
  const voiceChoices = VOICES.map((v) => ({
    title: v.label,
    value: v.voiceId,
  }));

  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.5",
    body: [
      {
        type: "TextBlock",
        text: "Script-to-Storyboard",
        weight: "Bolder",
        size: "Large",
        wrap: true,
      },
      {
        type: "TextBlock",
        text: "Upload a script file or paste your script text below. I'll parse it into scenes and provision your storyboard across Boords and ElevenLabs.",
        wrap: true,
        spacing: "Small",
      },
      {
        type: "Container",
        separator: true,
        spacing: "Medium",
        items: [
          {
            type: "TextBlock",
            text: "Script Input",
            weight: "Bolder",
            size: "Medium",
          },
          {
            type: "TextBlock",
            text: "Attach a .docx or .txt file to your message, OR paste script text below:",
            wrap: true,
            spacing: "Small",
          },
          {
            type: "Input.Text",
            id: "scriptText",
            placeholder: "Paste your script here...",
            isMultiline: true,
            maxLength: 50000,
            spacing: "Small",
          },
        ],
      },
      {
        type: "Container",
        separator: true,
        spacing: "Medium",
        items: [
          {
            type: "TextBlock",
            text: "Project Settings",
            weight: "Bolder",
            size: "Medium",
          },
          {
            type: "TextBlock",
            text: "Project Name",
            spacing: "Small",
          },
          {
            type: "Input.Text",
            id: "projectName",
            placeholder: "My Storyboard Project",
            isRequired: true,
            errorMessage: "Project name is required.",
          },
          {
            type: "TextBlock",
            text: "Video Style",
            spacing: "Small",
          },
          {
            type: "Input.ChoiceSet",
            id: "videoStyle",
            value: "Cinematic",
            choices: [
              { title: "Cinematic", value: "Cinematic" },
              { title: "Explainer-Animation", value: "Explainer-Animation" },
              { title: "Social-Fast Cut", value: "Social-Fast Cut" },
              { title: "Corporate", value: "Corporate" },
              { title: "Documentary", value: "Documentary" },
            ],
          },
          {
            type: "TextBlock",
            text: "ElevenLabs Voice",
            spacing: "Small",
          },
          {
            type: "Input.ChoiceSet",
            id: "selectedVoiceId",
            value: voiceChoices.length > 0 ? voiceChoices[0].value : "",
            choices: voiceChoices,
          },
          {
            type: "TextBlock",
            text: "Aspect Ratio",
            spacing: "Small",
          },
          {
            type: "Input.ChoiceSet",
            id: "aspectRatio",
            value: "16:9",
            choices: [
              { title: "16:9 (Widescreen)", value: "16:9" },
              { title: "9:16 (Vertical)", value: "9:16" },
              { title: "1:1 (Square)", value: "1:1" },
              { title: "4:3 (Standard)", value: "4:3" },
            ],
          },
          {
            type: "TextBlock",
            text: "Seconds Per Frame",
            spacing: "Small",
          },
          {
            type: "Input.Number",
            id: "secondsPerFrame",
            placeholder: "5",
            value: 5,
            min: 1,
            max: 60,
          },
          {
            type: "TextBlock",
            text: "Scene Extraction Mode",
            spacing: "Small",
          },
          {
            type: "Input.ChoiceSet",
            id: "extractionMode",
            value: "sentence",
            choices: [
              {
                title: "Sentence Split (one sentence per frame)",
                value: "sentence",
              },
              {
                title: "AI-Powered (Claude analyses scenes)",
                value: "ai",
              },
            ],
          },
        ],
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Create Storyboard",
        data: {
          action: "createStoryboard",
        },
        style: "positive",
      },
    ],
  };
}

/**
 * Builds a progress card showing the current status of each phase.
 */
export function buildProgressCard(projectName, statuses, currentMessage) {
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.5",
    body: [
      {
        type: "TextBlock",
        text: "Storyboard Progress",
        weight: "Bolder",
        size: "Large",
        wrap: true,
      },
      {
        type: "TextBlock",
        text: projectName,
        weight: "Bolder",
        size: "Medium",
        color: "Accent",
        wrap: true,
      },
      {
        type: "FactSet",
        facts: [
          { title: "Script Parsing", value: statuses.parsing || "Pending" },
          { title: "Scene Extraction", value: statuses.extraction || "Pending" },
          { title: "Boords Storyboard", value: statuses.boords || "Pending" },
          { title: "ElevenLabs Voiceover", value: statuses.elevenlabs || "Pending" },
        ],
      },
      {
        type: "TextBlock",
        text: currentMessage || "",
        wrap: true,
        spacing: "Medium",
        isSubtle: true,
      },
    ],
  };
}

/**
 * Builds the summary card showing final results with service links.
 */
export function buildSummaryCard(result) {
  const totalMinutes = Math.floor(result.totalDurationSeconds / 60);
  const totalSeconds = result.totalDurationSeconds % 60;
  const runtimeDisplay =
    totalMinutes > 0
      ? `${totalMinutes}m ${totalSeconds}s`
      : `${totalSeconds}s`;

  // Build service links fact set
  const serviceLinks = [];

  serviceLinks.push({
    title: "Boords Storyboard",
    value: result.boardsUrl
      ? `[Open in Boords](${result.boardsUrl})`
      : getErrorForService("Boords", result.errors),
  });

  serviceLinks.push({
    title: "ElevenLabs Voiceover",
    value: result.elevenLabsUrl
      ? `[Open in ElevenLabs](${result.elevenLabsUrl})`
      : getErrorForService("ElevenLabs", result.errors),
  });

  // Build scene preview (first 3 scenes)
  const previewScenes = result.scenes.slice(0, 3);
  const scenePreview =
    previewScenes.length > 0
      ? previewScenes
          .map(
            (s, i) =>
              `${i + 1}. ${s.title} (${s.shotType}, ${s.durationSeconds}s)`
          )
          .join("\n")
      : "No scenes extracted";

  // Build error details
  const errorDetails =
    result.errors.length > 0
      ? result.errors.map((e) => `${e.service}: ${e.message}`).join("\n")
      : "";

  const body = [
    {
      type: "TextBlock",
      text:
        result.errors.length === 0
          ? "Storyboard Complete"
          : "Storyboard Complete (with issues)",
      weight: "Bolder",
      size: "Large",
      color: result.errors.length === 0 ? "Good" : "Warning",
      wrap: true,
    },
    {
      type: "TextBlock",
      text: result.projectName,
      weight: "Bolder",
      size: "Medium",
      wrap: true,
    },
    {
      type: "ColumnSet",
      columns: [
        {
          type: "Column",
          width: "auto",
          items: [
            {
              type: "TextBlock",
              text: "Total Frames",
              weight: "Bolder",
              isSubtle: true,
            },
            {
              type: "TextBlock",
              text: String(result.scenes.length),
              size: "ExtraLarge",
              color: "Accent",
            },
          ],
        },
        {
          type: "Column",
          width: "auto",
          items: [
            {
              type: "TextBlock",
              text: "Est. Runtime",
              weight: "Bolder",
              isSubtle: true,
            },
            {
              type: "TextBlock",
              text: runtimeDisplay,
              size: "ExtraLarge",
              color: "Accent",
            },
          ],
        },
      ],
    },
    {
      type: "Container",
      separator: true,
      spacing: "Medium",
      items: [
        {
          type: "TextBlock",
          text: "Service Links",
          weight: "Bolder",
          size: "Medium",
        },
        {
          type: "FactSet",
          facts: serviceLinks,
        },
      ],
    },
    {
      type: "Container",
      separator: true,
      spacing: "Medium",
      items: [
        {
          type: "TextBlock",
          text: "Scene Preview (first 3)",
          weight: "Bolder",
          size: "Medium",
        },
        {
          type: "TextBlock",
          text: scenePreview,
          wrap: true,
          isSubtle: true,
        },
      ],
    },
  ];

  // Add error section if errors exist
  if (result.errors.length > 0) {
    body.push({
      type: "Container",
      separator: true,
      spacing: "Medium",
      items: [
        {
          type: "TextBlock",
          text: "Issues",
          weight: "Bolder",
          size: "Medium",
          color: "Warning",
        },
        {
          type: "TextBlock",
          text: errorDetails,
          wrap: true,
          color: "Warning",
        },
      ],
    });
  }

  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.5",
    body,
  };
}

/**
 * Gets the error status string for a given service.
 */
function getErrorForService(serviceName, errors) {
  const error = errors.find((e) => e.service === serviceName);
  if (error) {
    return `Failed: ${error.message}`;
  }
  return "Not requested";
}
