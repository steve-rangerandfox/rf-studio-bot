/**
 * Folder structure templates for project provisioning.
 * Equivalent to src/templates/folderStructure.json as a JS module.
 */

export const FOLDER_STRUCTURE = {
  frameio: [
    "01_Assets",
    "02_Progress",
    "03_Outgoing",
    "04_Feedback",
    "05_FinalDelivery",
  ],
  onedrive: [
    {
      name: "01_PRE-PRODUCTION",
      children: ["Brief", "Scripts", "Storyboards", "Moodboards"],
    },
    {
      name: "02_PRODUCTION",
      children: ["Footage", "Audio", "Assets"],
    },
    {
      name: "03_POST-PRODUCTION",
      children: ["Edits", "Graphics", "Color", "Audio Mix"],
    },
    {
      name: "04_DELIVERY",
      children: ["Finals", "Archives", "Client Exports"],
    },
    {
      name: "05_ADMIN",
      children: ["Contracts", "Invoices", "Correspondence"],
    },
  ],
  clockifyTasks: [
    "Pre-Production",
    "Design / Motion Graphics",
    "Animation",
    "Edit",
    "Sound Design",
    "Client Revisions",
    "Final Delivery",
  ],
};
