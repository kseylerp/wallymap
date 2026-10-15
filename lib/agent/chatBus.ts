/**
 * A tiny bridge so components outside the chat (the inspect card's "Ask about this") can send a chat message
 * without threading `sendMessage` through the app. ChatRail registers the one real sender.
 */
type Sender = (text: string) => boolean;

const senders = new Set<Sender>();

/** Registers a sender; returns the unsubscribe function (use it as an effect cleanup). */
export function onChatSend(sender: Sender): () => void {
  senders.add(sender);
  return () => {
    senders.delete(sender);
  };
}

/** Sends `text` as a user message. False when no chat is mounted or it is busy answering. */
export function sendChat(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  let sent = false;
  for (const sender of senders) sent = sender(trimmed) || sent;
  return sent;
}

/** Puts text in the composer for the user to finish (the hex card's "Ask about this cell"); returns the unsubscribe. */
type Filler = (text: string) => boolean;

const fillers = new Set<Filler>();

export function onChatPrefill(filler: Filler): () => void {
  fillers.add(filler);
  return () => {
    fillers.delete(filler);
  };
}

/** Prefills the composer with `text` and focuses it, without sending. False when no chat is mounted. */
export function prefillChat(text: string): boolean {
  let done = false;
  for (const filler of fillers) done = filler(text) || done;
  return done;
}
