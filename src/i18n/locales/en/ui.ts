/* Notices for buttons, labels, choices and channel adoption (`notice-text-ui.ts`). */
export const enUi = {
  "ui.askAfterLocation": 'Put your question after "location:{name}".',
  "ui.channelAdopted":
    "Linked #{name} to the {space} space (task mode). Send me a path if you want to add a working location.",
  "ui.adoptRefused.not-private":
    "I didn't link this channel because it isn't private. Sync its permissions with the category so only you and the bot can see it, then mention me again.",
  "ui.adoptRefused.ambiguous":
    "I didn't link this channel because its category matches more than one space. Check the space setup.",
  "ui.adoptRefused.name-taken":
    "I didn't link this channel because too many channels already share this name. Rename it and mention me again.",
  "ui.adoptRefused.failed":
    "I couldn't link this channel (the logs have details). Try again, or use /init-channel.",
  "ui.approval.approve": "Approve",
  "ui.approval.deny": "Deny",
  "ui.approval.owner-only": "Only the owner can approve this.",
  "ui.approval.expired": "This one has expired.",
  "ui.approval.timeout": "Timed out.",
  "ui.approval.cancelled": "Cancelled.",
  "ui.approval.enter": "Type your answer",
  "ui.approval.modal-title": "Your answer",
  "ui.approval.placeholder": "Pick an option",
  "ui.approval.full-text": "(full text in the attached file)",
  "ui.approval.options-in-file":
    "The options are in the attached file. Use the button to type your answer.",
  "ui.label.yes-run": "Yes, go ahead",
  "ui.label.no": "No",
  "ui.label.reply-attached": "[full reply attached]",
  "ui.label.full-result": "Full result",
  "ui.choice.chose": "You chose: {text}",
  "ui.choice.answered": "You answered: {text}",
} as const;
