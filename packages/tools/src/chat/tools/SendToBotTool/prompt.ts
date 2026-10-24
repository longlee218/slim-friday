/** Description the model reads for `SendToBot`. */
export const SEND_TO_BOT_DESCRIPTION =
  "Send a message to another bot of your group. This is the only way to wake a bot: writing @Name in your text does " +
  "not reach it. `intent` says what you expect: request (do this; its final answer returns to you), question " +
  "(answer me), result (the outcome of work you were given), status (progress on it), fyi (no reply wanted). " +
  "Delivery is asynchronous and the call does not end your turn: keep working, do not poll, do not send " +
  "acknowledgements, and send a later update only when it adds something new. Put the real content in the message " +
  "(names, numbers, file paths in the group's shared folder), not a note that something exists. The message is " +
  "shown in the channel under your name.";
